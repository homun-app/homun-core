use crate::{SkillRuntimeError, SkillRuntimeResult};
use std::path::{Path, PathBuf};
use wasmtime::{Config, Engine, Module};

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
