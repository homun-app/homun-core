//! Lean in-process Prometheus metrics registry — zero extra dependencies.
//!
//! Exposes a global [`MetricsRegistry`] accessible via [`metrics()`] with three
//! families: counters, gauges, histograms. Rendering produces Prometheus text
//! exposition format (version 0.0.4), suitable for scraping by Prometheus,
//! Grafana Agent, VictoriaMetrics, or any other compatible collector.
//!
//! ## Design notes
//!
//! - **No external crates**: uses `std::sync::{RwLock, atomic::AtomicU64}` only.
//!   The `prometheus` and `metrics-exporter-prometheus` crates each pull in 15+
//!   transitive deps for features (labels, push gateway, protobuf) we don't need.
//! - **Family registration at boot**: call [`register_counter`], [`register_gauge`],
//!   [`register_histogram`] once during startup to install help text. Subsequent
//!   `*_inc` / `*_set` / `*_observe` calls are lock-free on the hot path for
//!   already-seen (name, labels) pairs; only new label combinations take the
//!   write lock briefly.
//! - **Gauge stores f64 as u64 bits**: uses [`f64::to_bits`] / [`f64::from_bits`]
//!   so we can still use [`AtomicU64`] for lock-free updates. Works because the
//!   bit representation is total and preserved by atomic ops.
//! - **Histogram buckets are fixed at registration time**: this matches Prometheus
//!   semantics and allows us to store observations as an array of AtomicU64s
//!   indexed by bucket, lock-free on observe.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

/// Default histogram buckets (seconds) — matches Prometheus defaults.
///
/// Suitable for web request latency, tool execution, LLM calls, cognition.
pub const DEFAULT_LATENCY_BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

/// Returns the global metrics registry, initializing it on first access.
pub fn metrics() -> &'static MetricsRegistry {
    static REGISTRY: OnceLock<MetricsRegistry> = OnceLock::new();
    REGISTRY.get_or_init(MetricsRegistry::new)
}

/// Register all Homun metrics families with their help text and bucket bounds.
///
/// Call once at gateway boot (after config load, before first metric observation).
/// Safe to call multiple times — subsequent calls are no-ops for already-registered
/// families.
pub fn register_homun_metrics() {
    let r = metrics();

    // --- Counters ---
    r.register_counter(
        "homun_requests_total",
        "Total number of user requests processed by the agent loop.",
    );
    r.register_counter(
        "homun_tool_calls_total",
        "Total number of tool invocations by name and outcome.",
    );
    r.register_counter(
        "homun_llm_tokens_total",
        "Total LLM tokens counted across all providers and directions.",
    );

    // --- Gauges ---
    r.register_gauge(
        "homun_active_sessions",
        "Current number of active agent sessions.",
    );
    r.register_gauge(
        "homun_memory_chunks_total",
        "Current total number of memory chunks indexed.",
    );
    r.register_gauge(
        "homun_vault_entries_total",
        "Current number of encrypted vault entries.",
    );
    r.register_gauge(
        "homun_rag_documents_total",
        "Current number of RAG knowledge base documents.",
    );
    r.register_gauge("homun_uptime_seconds", "Seconds since the gateway started.");
    r.register_gauge(
        "homun_heartbeat_last_fire_timestamp",
        "Unix timestamp of the last heartbeat fire (0 if never fired — surfaces bug #64).",
    );

    // --- Histograms ---
    r.register_histogram(
        "homun_cognition_latency_seconds",
        "Duration of the cognition phase in seconds.",
        DEFAULT_LATENCY_BUCKETS,
    );
    r.register_histogram(
        "homun_tool_execution_latency_seconds",
        "Duration of individual tool invocations in seconds.",
        DEFAULT_LATENCY_BUCKETS,
    );
    r.register_histogram(
        "homun_llm_latency_seconds",
        "Duration of LLM provider calls in seconds.",
        DEFAULT_LATENCY_BUCKETS,
    );
}

// =============================================================================
// Convenience free functions — short call sites at instrumentation points
// =============================================================================

/// Increment a counter by `n` with the given label set.
///
/// The counter must have been previously registered via [`register_counter`];
/// unregistered names are silently ignored (lost counts). This keeps the hot
/// path lock-free and avoids accidental typo-series pollution.
pub fn counter_inc(name: &str, labels: &[(&str, &str)], n: u64) {
    metrics().counter_inc(name, labels, n);
}

/// Set a gauge to the given value with the given label set.
pub fn gauge_set(name: &str, labels: &[(&str, &str)], value: f64) {
    metrics().gauge_set(name, labels, value);
}

/// Observe a single value in a histogram with the given label set.
pub fn histogram_observe(name: &str, labels: &[(&str, &str)], value: f64) {
    metrics().histogram_observe(name, labels, value);
}

/// Render the full registry as Prometheus text exposition format (v0.0.4).
pub fn render() -> String {
    metrics().render()
}

// =============================================================================
// Registry
// =============================================================================

/// In-process metrics registry — counters, gauges, histograms by family name.
pub struct MetricsRegistry {
    inner: RwLock<Inner>,
}

#[derive(Default)]
struct Inner {
    counters: BTreeMap<String, CounterFamily>,
    gauges: BTreeMap<String, GaugeFamily>,
    histograms: BTreeMap<String, HistogramFamily>,
}

impl MetricsRegistry {
    /// Construct a fresh, empty registry.
    ///
    /// Production code should use the global [`metrics()`] singleton — this
    /// constructor exists so unit tests can create isolated registries.
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(Inner::default()),
        }
    }

    pub fn register_counter(&self, name: &str, help: &str) {
        let mut inner = self.inner.write().unwrap();
        inner
            .counters
            .entry(name.to_string())
            .or_insert_with(|| CounterFamily {
                help: help.to_string(),
                series: HashMap::new(),
            });
    }

    pub fn register_gauge(&self, name: &str, help: &str) {
        let mut inner = self.inner.write().unwrap();
        inner
            .gauges
            .entry(name.to_string())
            .or_insert_with(|| GaugeFamily {
                help: help.to_string(),
                series: HashMap::new(),
            });
    }

    pub fn register_histogram(&self, name: &str, help: &str, buckets: &[f64]) {
        let mut inner = self.inner.write().unwrap();
        inner
            .histograms
            .entry(name.to_string())
            .or_insert_with(|| HistogramFamily {
                help: help.to_string(),
                buckets: buckets.to_vec(),
                series: HashMap::new(),
            });
    }

    /// Increment a counter by `n`. Silently no-op if the family isn't registered.
    pub fn counter_inc(&self, name: &str, labels: &[(&str, &str)], n: u64) {
        let key = labels_key(labels);

        // Fast path: family exists AND series exists — read lock only.
        {
            let inner = self.inner.read().unwrap();
            if let Some(family) = inner.counters.get(name) {
                if let Some(series) = family.series.get(&key) {
                    series.value.fetch_add(n, Ordering::Relaxed);
                    return;
                }
            } else {
                // Unregistered family — drop silently.
                return;
            }
        }

        // Slow path: insert new series.
        let mut inner = self.inner.write().unwrap();
        if let Some(family) = inner.counters.get_mut(name) {
            let series = family.series.entry(key).or_insert_with(|| Series {
                labels: own_labels(labels),
                value: Arc::new(AtomicU64::new(0)),
            });
            series.value.fetch_add(n, Ordering::Relaxed);
        }
    }

    /// Set a gauge value. Silently no-op if the family isn't registered.
    pub fn gauge_set(&self, name: &str, labels: &[(&str, &str)], value: f64) {
        let key = labels_key(labels);
        let bits = value.to_bits();

        {
            let inner = self.inner.read().unwrap();
            if let Some(family) = inner.gauges.get(name) {
                if let Some(series) = family.series.get(&key) {
                    series.value.store(bits, Ordering::Relaxed);
                    return;
                }
            } else {
                return;
            }
        }

        let mut inner = self.inner.write().unwrap();
        if let Some(family) = inner.gauges.get_mut(name) {
            let series = family.series.entry(key).or_insert_with(|| Series {
                labels: own_labels(labels),
                value: Arc::new(AtomicU64::new(0)),
            });
            series.value.store(bits, Ordering::Relaxed);
        }
    }

    /// Observe a histogram value. Silently no-op if the family isn't registered.
    pub fn histogram_observe(&self, name: &str, labels: &[(&str, &str)], value: f64) {
        let key = labels_key(labels);

        // Fast path: family AND series exist.
        {
            let inner = self.inner.read().unwrap();
            if let Some(family) = inner.histograms.get(name) {
                if let Some(series) = family.series.get(&key) {
                    series.observe(value);
                    return;
                }
            } else {
                return;
            }
        }

        // Slow path: create series.
        let mut inner = self.inner.write().unwrap();
        if let Some(family) = inner.histograms.get_mut(name) {
            let buckets = family.buckets.clone();
            let series = family
                .series
                .entry(key)
                .or_insert_with(|| HistogramSeries::new(own_labels(labels), &buckets));
            series.observe(value);
        }
    }

    /// Render the full registry as Prometheus text exposition format.
    ///
    /// Format reference: https://prometheus.io/docs/instrumenting/exposition_formats/
    pub fn render(&self) -> String {
        let inner = self.inner.read().unwrap();
        let mut out = String::with_capacity(4096);

        // Counters
        for (name, family) in &inner.counters {
            writeln_help_type(&mut out, name, &family.help, "counter");
            // Sort series by label key for deterministic output
            let mut series: Vec<_> = family.series.values().collect();
            series.sort_by(|a, b| a.labels.cmp(&b.labels));
            for s in series {
                let v = s.value.load(Ordering::Relaxed);
                out.push_str(name);
                out.push_str(&render_labels(&s.labels));
                out.push(' ');
                out.push_str(&v.to_string());
                out.push('\n');
            }
        }

        // Gauges
        for (name, family) in &inner.gauges {
            writeln_help_type(&mut out, name, &family.help, "gauge");
            let mut series: Vec<_> = family.series.values().collect();
            series.sort_by(|a, b| a.labels.cmp(&b.labels));
            for s in series {
                let bits = s.value.load(Ordering::Relaxed);
                let v = f64::from_bits(bits);
                out.push_str(name);
                out.push_str(&render_labels(&s.labels));
                out.push(' ');
                out.push_str(&format_f64(v));
                out.push('\n');
            }
        }

        // Histograms
        for (name, family) in &inner.histograms {
            writeln_help_type(&mut out, name, &family.help, "histogram");
            let mut series: Vec<_> = family.series.values().collect();
            series.sort_by(|a, b| a.labels.cmp(&b.labels));
            for s in series {
                render_histogram_series(&mut out, name, s);
            }
        }

        out
    }
}

// =============================================================================
// Family types
// =============================================================================

struct CounterFamily {
    help: String,
    series: HashMap<String, Series>,
}

struct GaugeFamily {
    help: String,
    series: HashMap<String, Series>,
}

struct HistogramFamily {
    help: String,
    buckets: Vec<f64>,
    series: HashMap<String, HistogramSeries>,
}

/// A single (labels, value) time-series inside a counter or gauge family.
struct Series {
    labels: Vec<(String, String)>,
    value: Arc<AtomicU64>,
}

/// A single (labels, buckets, sum, count) time-series inside a histogram family.
struct HistogramSeries {
    labels: Vec<(String, String)>,
    /// Bucket upper bounds and cumulative counts.
    /// `buckets[i].1` is the count of observations <= `buckets[i].0`.
    buckets: Vec<(f64, AtomicU64)>,
    /// Total count of observations (always equal to the +Inf bucket).
    count: AtomicU64,
    /// Sum of all observations (stored as u64 bits for atomicity).
    sum_bits: AtomicU64,
}

impl HistogramSeries {
    fn new(labels: Vec<(String, String)>, bounds: &[f64]) -> Self {
        Self {
            labels,
            buckets: bounds.iter().map(|b| (*b, AtomicU64::new(0))).collect(),
            count: AtomicU64::new(0),
            sum_bits: AtomicU64::new(0.0_f64.to_bits()),
        }
    }

    fn observe(&self, value: f64) {
        // Cumulative bucket counts (le = less-than-or-equal semantics).
        for (bound, count) in &self.buckets {
            if value <= *bound {
                count.fetch_add(1, Ordering::Relaxed);
            }
        }
        self.count.fetch_add(1, Ordering::Relaxed);

        // Compare-and-swap loop to add `value` to the sum atomically.
        let mut current = self.sum_bits.load(Ordering::Relaxed);
        loop {
            let new = (f64::from_bits(current) + value).to_bits();
            match self.sum_bits.compare_exchange_weak(
                current,
                new,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(actual) => current = actual,
            }
        }
    }
}

// =============================================================================
// Rendering helpers
// =============================================================================

fn writeln_help_type(out: &mut String, name: &str, help: &str, kind: &str) {
    out.push_str("# HELP ");
    out.push_str(name);
    out.push(' ');
    out.push_str(&escape_help(help));
    out.push('\n');
    out.push_str("# TYPE ");
    out.push_str(name);
    out.push(' ');
    out.push_str(kind);
    out.push('\n');
}

fn render_labels(labels: &[(String, String)]) -> String {
    if labels.is_empty() {
        return String::new();
    }
    let mut sorted: Vec<&(String, String)> = labels.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let pairs: Vec<String> = sorted
        .iter()
        .map(|(k, v)| format!("{}=\"{}\"", k, escape_label_value(v)))
        .collect();
    format!("{{{}}}", pairs.join(","))
}

fn render_histogram_series(out: &mut String, name: &str, s: &HistogramSeries) {
    // Render each bucket as `<name>_bucket{...,le="<bound>"} <count>`
    // Note: we add an explicit `le="+Inf"` bucket at the end per Prometheus spec.
    for (bound, count) in &s.buckets {
        let bucket_labels = with_label(&s.labels, "le", &format_f64(*bound));
        out.push_str(name);
        out.push_str("_bucket");
        out.push_str(&render_labels(&bucket_labels));
        out.push(' ');
        out.push_str(&count.load(Ordering::Relaxed).to_string());
        out.push('\n');
    }

    let count = s.count.load(Ordering::Relaxed);

    // +Inf bucket (equal to total count — mandatory per spec)
    let inf_labels = with_label(&s.labels, "le", "+Inf");
    out.push_str(name);
    out.push_str("_bucket");
    out.push_str(&render_labels(&inf_labels));
    out.push(' ');
    out.push_str(&count.to_string());
    out.push('\n');

    // _sum
    let sum = f64::from_bits(s.sum_bits.load(Ordering::Relaxed));
    out.push_str(name);
    out.push_str("_sum");
    out.push_str(&render_labels(&s.labels));
    out.push(' ');
    out.push_str(&format_f64(sum));
    out.push('\n');

    // _count
    out.push_str(name);
    out.push_str("_count");
    out.push_str(&render_labels(&s.labels));
    out.push(' ');
    out.push_str(&count.to_string());
    out.push('\n');
}

fn with_label(base: &[(String, String)], key: &str, value: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = base.to_vec();
    out.push((key.to_string(), value.to_string()));
    out
}

fn labels_key(labels: &[(&str, &str)]) -> String {
    let mut sorted: Vec<(&str, &str)> = labels.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    sorted
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join(",")
}

fn own_labels(labels: &[(&str, &str)]) -> Vec<(String, String)> {
    labels
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn escape_label_value(v: &str) -> String {
    v.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

fn escape_help(v: &str) -> String {
    v.replace('\\', "\\\\").replace('\n', "\\n")
}

/// Format an `f64` for Prometheus exposition: integer if whole, else shortest decimal.
fn format_f64(v: f64) -> String {
    if v.is_nan() {
        return "NaN".to_string();
    }
    if v.is_infinite() {
        return if v > 0.0 {
            "+Inf".to_string()
        } else {
            "-Inf".to_string()
        };
    }
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        // Use default f64 Display; Prometheus accepts it.
        format!("{}", v)
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a fresh registry for isolated tests (can't re-init OnceLock).
    fn fresh_registry() -> MetricsRegistry {
        MetricsRegistry::new()
    }

    #[test]
    fn counter_increments_and_renders() {
        let r = fresh_registry();
        r.register_counter("homun_test_total", "Test counter.");
        r.counter_inc("homun_test_total", &[("status", "ok")], 1);
        r.counter_inc("homun_test_total", &[("status", "ok")], 2);
        r.counter_inc("homun_test_total", &[("status", "error")], 1);

        let out = r.render();
        assert!(out.contains("# HELP homun_test_total Test counter."));
        assert!(out.contains("# TYPE homun_test_total counter"));
        assert!(out.contains("homun_test_total{status=\"ok\"} 3"));
        assert!(out.contains("homun_test_total{status=\"error\"} 1"));
    }

    #[test]
    fn gauge_set_preserves_float() {
        let r = fresh_registry();
        r.register_gauge("homun_test_gauge", "Test gauge.");
        // Use a non-PI-like constant to avoid clippy::approx_constant.
        r.gauge_set("homun_test_gauge", &[], 2.71);
        let out = r.render();
        assert!(out.contains("homun_test_gauge 2.71"));

        r.gauge_set("homun_test_gauge", &[], 42.0);
        let out = r.render();
        assert!(out.contains("homun_test_gauge 42")); // Integer-valued float elides decimal
    }

    #[test]
    fn gauge_negative_and_special_values() {
        let r = fresh_registry();
        r.register_gauge("homun_test_gauge", "Test gauge.");
        r.gauge_set("homun_test_gauge", &[], -1.5);
        let out = r.render();
        assert!(out.contains("homun_test_gauge -1.5"));
    }

    #[test]
    fn histogram_observes_and_renders_buckets() {
        let r = fresh_registry();
        r.register_histogram("homun_test_latency", "Test latency.", &[0.1, 1.0, 10.0]);
        r.histogram_observe("homun_test_latency", &[("op", "read")], 0.05);
        r.histogram_observe("homun_test_latency", &[("op", "read")], 0.5);
        r.histogram_observe("homun_test_latency", &[("op", "read")], 5.0);

        let out = r.render();
        assert!(out.contains("# TYPE homun_test_latency histogram"));
        // 0.05 ≤ 0.1 → count 1 in le=0.1
        assert!(out.contains("homun_test_latency_bucket{le=\"0.1\",op=\"read\"} 1"));
        // 0.05, 0.5 ≤ 1.0 → count 2
        assert!(out.contains("homun_test_latency_bucket{le=\"1\",op=\"read\"} 2"));
        // All three ≤ 10.0 → count 3
        assert!(out.contains("homun_test_latency_bucket{le=\"10\",op=\"read\"} 3"));
        // +Inf bucket = count
        assert!(out.contains("homun_test_latency_bucket{le=\"+Inf\",op=\"read\"} 3"));
        // Sum
        assert!(out.contains("homun_test_latency_sum{op=\"read\"} 5.55"));
        // Count
        assert!(out.contains("homun_test_latency_count{op=\"read\"} 3"));
    }

    #[test]
    fn unregistered_counter_is_silent_noop() {
        let r = fresh_registry();
        // Not registered — should not panic, should not appear in render.
        r.counter_inc("homun_unregistered_total", &[], 1);
        let out = r.render();
        assert!(!out.contains("homun_unregistered_total"));
    }

    #[test]
    fn label_value_escaping() {
        let r = fresh_registry();
        r.register_counter("homun_test_total", "Escape test.");
        r.counter_inc("homun_test_total", &[("path", "/hello\"world\n")], 1);
        let out = r.render();
        // Backslash, quote, and newline must be escaped per Prometheus spec.
        assert!(out.contains(r#"path="/hello\"world\n""#));
    }

    #[test]
    fn deterministic_label_ordering() {
        let r = fresh_registry();
        r.register_counter("homun_test_total", "Order test.");
        // Insert labels in reverse alphabetical order
        r.counter_inc("homun_test_total", &[("z", "1"), ("a", "2")], 1);
        let out = r.render();
        // Should render with labels sorted a,z (canonical form)
        assert!(out.contains("homun_test_total{a=\"2\",z=\"1\"} 1"));
    }

    #[test]
    fn default_buckets_cover_web_latency() {
        // Sanity check that our default buckets span the range a web agent needs.
        assert!(DEFAULT_LATENCY_BUCKETS.first().copied().unwrap() < 0.01);
        assert!(DEFAULT_LATENCY_BUCKETS.last().copied().unwrap() >= 10.0);
        // Strictly increasing
        for w in DEFAULT_LATENCY_BUCKETS.windows(2) {
            assert!(w[0] < w[1]);
        }
    }

    #[test]
    fn register_is_idempotent() {
        let r = fresh_registry();
        r.register_counter("homun_test_total", "First.");
        r.counter_inc("homun_test_total", &[], 5);
        // Second registration should NOT reset the counter.
        r.register_counter("homun_test_total", "Second (ignored).");
        r.counter_inc("homun_test_total", &[], 3);
        let out = r.render();
        assert!(out.contains("homun_test_total 8"));
        assert!(out.contains("# HELP homun_test_total First."));
    }

    #[test]
    fn multiple_series_in_same_family() {
        let r = fresh_registry();
        r.register_counter("homun_requests_total", "Requests.");
        r.counter_inc(
            "homun_requests_total",
            &[("channel", "web"), ("status", "ok")],
            10,
        );
        r.counter_inc(
            "homun_requests_total",
            &[("channel", "telegram"), ("status", "ok")],
            5,
        );
        r.counter_inc(
            "homun_requests_total",
            &[("channel", "web"), ("status", "error")],
            2,
        );
        let out = r.render();
        assert!(out.contains("homun_requests_total{channel=\"web\",status=\"ok\"} 10"));
        assert!(out.contains("homun_requests_total{channel=\"telegram\",status=\"ok\"} 5"));
        assert!(out.contains("homun_requests_total{channel=\"web\",status=\"error\"} 2"));
    }
}
