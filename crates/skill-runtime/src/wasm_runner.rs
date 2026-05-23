use crate::{
    SkillRunner, SkillRuntimeError, SkillRuntimeOutput, SkillRuntimeRequest, SkillRuntimeResult,
};
use std::path::{Path, PathBuf};
use wasmtime::{Config, Engine, Instance, Memory, Module, Store, TypedFunc};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WasmSkillRunnerConfig {
    module_path: PathBuf,
    max_fuel: u64,
    max_memory_pages: u32,
}

impl WasmSkillRunnerConfig {
    pub fn new(
        module_path: impl Into<PathBuf>,
        allowed_roots: Vec<PathBuf>,
    ) -> SkillRuntimeResult<Self> {
        let module_path = canonicalize_path(module_path.into(), "wasm_module_not_found")?;
        let allowed_roots = canonicalize_roots(allowed_roots, "wasm_root_not_found")?;
        if !is_inside_any_root(&module_path, &allowed_roots) {
            return Err(SkillRuntimeError::RunnerFailed(
                "wasm_module_outside_allowed_roots".to_string(),
            ));
        }

        let module = compile_module(&module_path)?;
        if module.imports().next().is_some() {
            return Err(SkillRuntimeError::RunnerFailed(
                "wasm_imports_not_allowed".to_string(),
            ));
        }

        Ok(Self {
            module_path,
            max_fuel: 1_000_000,
            max_memory_pages: 4,
        })
    }

    pub fn with_max_fuel(mut self, max_fuel: u64) -> Self {
        self.max_fuel = max_fuel;
        self
    }

    pub fn with_max_memory_pages(mut self, max_memory_pages: u32) -> Self {
        self.max_memory_pages = max_memory_pages;
        self
    }

    pub fn module_path(&self) -> &Path {
        &self.module_path
    }

    pub fn max_fuel(&self) -> u64 {
        self.max_fuel
    }

    pub fn max_memory_pages(&self) -> u32 {
        self.max_memory_pages
    }
}

#[derive(Debug, Clone)]
pub struct WasmSkillRunner {
    config: WasmSkillRunnerConfig,
}

impl WasmSkillRunner {
    pub fn new(config: WasmSkillRunnerConfig) -> Self {
        Self { config }
    }
}

impl SkillRunner for WasmSkillRunner {
    fn run(&self, request: &SkillRuntimeRequest) -> SkillRuntimeResult<SkillRuntimeOutput> {
        let engine = wasm_engine()?;
        let module = Module::from_file(&engine, self.config.module_path())
            .map_err(|error| SkillRuntimeError::RunnerFailed(format!("wasm_compile:{error}")))?;
        if module.imports().next().is_some() {
            return Err(SkillRuntimeError::RunnerFailed(
                "wasm_imports_not_allowed".to_string(),
            ));
        }

        let mut store = Store::new(&engine, ());
        store
            .set_fuel(self.config.max_fuel())
            .map_err(|error| SkillRuntimeError::RunnerFailed(format!("wasm_fuel:{error}")))?;
        let instance = Instance::new(&mut store, &module, &[]).map_err(|error| {
            SkillRuntimeError::RunnerFailed(format!("wasm_instantiate:{error}"))
        })?;
        let memory = instance.get_memory(&mut store, "memory").ok_or_else(|| {
            SkillRuntimeError::RunnerFailed("wasm_memory_export_missing".to_string())
        })?;
        if memory.size(&store) > u64::from(self.config.max_memory_pages()) {
            return Err(SkillRuntimeError::RunnerFailed(
                "wasm_memory_too_large".to_string(),
            ));
        }

        let request_json = serde_json::to_vec(request)
            .map_err(|error| SkillRuntimeError::RunnerFailed(error.to_string()))?;
        write_guest_input(&mut store, &memory, &request_json)?;

        let run = instance
            .get_typed_func::<(i32, i32), i64>(&mut store, "run")
            .map_err(|_| SkillRuntimeError::RunnerFailed("wasm_run_export_missing".to_string()))?;
        let packed = call_run(&mut store, &run, request_json.len())?;
        let output = read_guest_output(&store, &memory, packed, request.limits.max_output_bytes)?;
        serde_json::from_slice(&output)
            .map_err(|error| SkillRuntimeError::RunnerFailed(format!("wasm_output_json:{error}")))
    }
}

fn compile_module(path: &Path) -> SkillRuntimeResult<Module> {
    Module::from_file(&wasm_engine()?, path)
        .map_err(|error| SkillRuntimeError::RunnerFailed(format!("wasm_compile:{error}")))
}

fn wasm_engine() -> SkillRuntimeResult<Engine> {
    let mut config = Config::new();
    config.consume_fuel(true);
    Engine::new(&config)
        .map_err(|error| SkillRuntimeError::RunnerFailed(format!("wasm_engine:{error}")))
}

fn canonicalize_roots(roots: Vec<PathBuf>, error: &str) -> SkillRuntimeResult<Vec<PathBuf>> {
    roots
        .into_iter()
        .map(|root| canonicalize_path(root, error))
        .collect()
}

fn canonicalize_path(path: PathBuf, error: &str) -> SkillRuntimeResult<PathBuf> {
    path.canonicalize()
        .map_err(|_| SkillRuntimeError::RunnerFailed(error.to_string()))
}

fn is_inside_any_root(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

fn write_guest_input(
    store: &mut Store<()>,
    memory: &Memory,
    request_json: &[u8],
) -> SkillRuntimeResult<()> {
    let memory_len = memory.data_size(&mut *store);
    if request_json.len() > memory_len {
        return Err(SkillRuntimeError::RunnerFailed(
            "wasm_input_too_large".to_string(),
        ));
    }
    memory
        .write(store, 0, request_json)
        .map_err(|error| SkillRuntimeError::RunnerFailed(format!("wasm_input:{error}")))
}

fn call_run(
    store: &mut Store<()>,
    run: &TypedFunc<(i32, i32), i64>,
    input_len: usize,
) -> SkillRuntimeResult<i64> {
    let input_len = i32::try_from(input_len)
        .map_err(|_| SkillRuntimeError::RunnerFailed("wasm_input_too_large".to_string()))?;
    run.call(store, (0, input_len))
        .map_err(|error| SkillRuntimeError::RunnerFailed(format!("wasm_trap:{error}")))
}

fn read_guest_output(
    store: &Store<()>,
    memory: &Memory,
    packed: i64,
    max_output_bytes: usize,
) -> SkillRuntimeResult<Vec<u8>> {
    let packed = u64::try_from(packed)
        .map_err(|_| SkillRuntimeError::RunnerFailed("wasm_output_pointer_invalid".to_string()))?;
    let output_ptr = (packed >> 32) as usize;
    let output_len = (packed & 0xffff_ffff) as usize;
    if output_len > max_output_bytes {
        return Err(SkillRuntimeError::OutputTooLarge(output_len));
    }
    let output_end = output_ptr
        .checked_add(output_len)
        .ok_or_else(|| SkillRuntimeError::RunnerFailed("wasm_output_out_of_bounds".to_string()))?;
    if output_end > memory.data_size(store) {
        return Err(SkillRuntimeError::RunnerFailed(
            "wasm_output_out_of_bounds".to_string(),
        ));
    }
    Ok(memory.data(store)[output_ptr..output_end].to_vec())
}
