//! Usage ledger runtime bootstrap owner.
//!
//! The HTTP usage routes own query/update surfaces. This module owns the
//! process startup bundle: durable ledger open, orphan cleanup, rollup rebuild,
//! buffered recorder construction and pricing snapshot wiring.

use std::{
    io,
    path::Path,
    sync::{Arc, Mutex, RwLock},
};

use local_first_inference_usage::UsageRecorder;

use crate::{
    build_usage_pricing_snapshot, now_epoch_secs, usage_pricing, usage_recorder_registry,
    usage_store,
};

pub(crate) struct GatewayUsageRuntime {
    pub(crate) store: Arc<Mutex<usage_store::UsageStore>>,
    pub(crate) recorder: Arc<dyn UsageRecorder>,
    pub(crate) pricing: Arc<RwLock<usage_pricing::PricingSnapshot>>,
}

pub(crate) fn open_gateway_usage_runtime(
    path: impl AsRef<Path>,
) -> io::Result<GatewayUsageRuntime> {
    open_gateway_usage_runtime_with_capacity(path, now_epoch_secs(), 4_096)
}

fn open_gateway_usage_runtime_with_capacity(
    path: impl AsRef<Path>,
    now_secs: u64,
    buffer_capacity: usize,
) -> io::Result<GatewayUsageRuntime> {
    let path = path.as_ref();
    let usage_store = usage_store::UsageStore::open(path).map_err(io::Error::other)?;
    usage_store
        .abort_orphaned_attempts(i64::try_from(now_secs).unwrap_or(i64::MAX))
        .map_err(io::Error::other)?;
    usage_store
        .rebuild_daily_rollups()
        .map_err(io::Error::other)?;

    let buffered_usage_recorder: Arc<dyn UsageRecorder> = Arc::new(
        usage_store::BufferedUsageRecorder::start(path, buffer_capacity)
            .map_err(io::Error::other)?,
    );
    let usage_pricing = Arc::new(RwLock::new(build_usage_pricing_snapshot(&usage_store)));
    let usage_recorder: Arc<dyn UsageRecorder> =
        Arc::new(usage_pricing::CostEnrichingUsageRecorder::new(
            buffered_usage_recorder,
            usage_pricing.clone(),
        ));

    Ok(GatewayUsageRuntime {
        store: Arc::new(Mutex::new(usage_store)),
        recorder: usage_recorder,
        pricing: usage_pricing,
    })
}

pub(crate) fn install_gateway_usage_recorder(recorder: Arc<dyn UsageRecorder>) {
    let _ = usage_recorder_registry().set(recorder);
}

#[cfg(test)]
mod tests {
    use super::open_gateway_usage_runtime_with_capacity;

    #[test]
    fn gateway_usage_runtime_opens_ledger_recorder_and_pricing_snapshot() {
        let path = std::env::temp_dir().join(format!(
            "homun-usage-runtime-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));

        {
            let runtime =
                open_gateway_usage_runtime_with_capacity(&path, 1_700_000_000, 8).expect("runtime");
            assert!(path.exists(), "usage sqlite file should be created");
            assert!(
                runtime.store.lock().is_ok(),
                "usage store should be wrapped for AppState"
            );
            assert!(
                runtime.pricing.read().is_ok(),
                "pricing snapshot should be readable"
            );
        }

        let _ = std::fs::remove_file(&path);
    }
}
