use crate::{MemoryError, MemoryRef, MemoryResult};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};

#[derive(Debug, Clone, PartialEq)]
pub struct VectorHit {
    pub memory_ref: MemoryRef,
    pub score: f32,
}

pub trait MemoryVectorIndex {
    fn upsert(&mut self, memory_ref: &MemoryRef, embedding: &[f32]) -> MemoryResult<()>;
    fn delete(&mut self, memory_ref: &MemoryRef) -> MemoryResult<()>;
    fn search(&self, query: &[f32], limit: usize) -> MemoryResult<Vec<VectorHit>>;
}

#[derive(Debug, Default, Clone)]
pub struct ExactMemoryVectorIndex {
    vectors: HashMap<MemoryRef, Vec<f32>>,
}

impl ExactMemoryVectorIndex {
    pub fn from_embeddings<I>(embeddings: I) -> MemoryResult<Self>
    where
        I: IntoIterator<Item = (MemoryRef, Vec<f32>)>,
    {
        let mut index = Self::default();
        for (memory_ref, vector) in embeddings {
            index.upsert(&memory_ref, &vector)?;
        }
        Ok(index)
    }

    pub fn len(&self) -> usize {
        self.vectors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.vectors.is_empty()
    }
}

impl MemoryVectorIndex for ExactMemoryVectorIndex {
    fn upsert(&mut self, memory_ref: &MemoryRef, embedding: &[f32]) -> MemoryResult<()> {
        validate_embedding(embedding)?;
        self.vectors.insert(memory_ref.clone(), embedding.to_vec());
        Ok(())
    }

    fn delete(&mut self, memory_ref: &MemoryRef) -> MemoryResult<()> {
        self.vectors.remove(memory_ref);
        Ok(())
    }

    fn search(&self, query: &[f32], limit: usize) -> MemoryResult<Vec<VectorHit>> {
        validate_embedding(query)?;
        if limit == 0 {
            return Ok(Vec::new());
        }

        let mut hits: Vec<VectorHit> = self
            .vectors
            .iter()
            .filter_map(|(memory_ref, vector)| {
                cosine_similarity(query, vector).map(|score| VectorHit {
                    memory_ref: memory_ref.clone(),
                    score,
                })
            })
            .collect();
        hits.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| a.memory_ref.to_string().cmp(&b.memory_ref.to_string()))
        });
        hits.truncate(limit);
        Ok(hits)
    }
}

// ---------------------------------------------------------------------------
// Distance metrics
// ---------------------------------------------------------------------------

/// Supported distance functions for HNSW search.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistanceMetric {
    Cosine,
    Euclidean,
}

/// Compute distance between two vectors (lower = more similar).
fn compute_distance(a: &[f32], b: &[f32], metric: DistanceMetric) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    match metric {
        DistanceMetric::Cosine => 1.0 - cosine_similarity_unchecked(a, b),
        DistanceMetric::Euclidean => euclidean_distance(a, b),
    }
}

/// Cosine similarity without length check — caller guarantees equal lengths.
fn cosine_similarity_unchecked(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for (left, right) in a.iter().zip(b) {
        dot += left * right;
        norm_a += left * left;
        norm_b += right * right;
    }
    if norm_a <= f32::EPSILON || norm_b <= f32::EPSILON {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

fn euclidean_distance(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y) * (x - y))
        .sum::<f32>()
        .sqrt()
}

// ---------------------------------------------------------------------------
// OrderedF32 — wrapper for f32 that implements Ord (for BinaryHeap)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
struct OrderedF32(f32);

impl Eq for OrderedF32 {}

impl PartialOrd for OrderedF32 {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for OrderedF32 {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0)
    }
}

// ---------------------------------------------------------------------------
// HNSW index
// ---------------------------------------------------------------------------

/// Threshold below which we fall back to exact brute-force search.
const HNSW_FALLBACK_THRESHOLD: usize = 100;

/// Default maximum number of bi-directional connections per element per layer.
const DEFAULT_M: usize = 16;
/// Default size of the dynamic candidate list during construction.
const DEFAULT_EF_CONSTRUCTION: usize = 200;
/// Default size of the dynamic candidate list during search.
const DEFAULT_EF_SEARCH: usize = 64;

/// A single node stored in the HNSW graph.
struct HnswNode {
    vector: Vec<f32>,
    /// `neighbors[layer]` = list of neighbor node ids at that layer.
    neighbors: Vec<Vec<u64>>,
}

/// Incremental HNSW index supporting insert, delete, and approximate
/// nearest-neighbor search.  Falls back to brute-force for small datasets
/// where exact search is faster.
pub struct HnswMemoryVectorIndex {
    nodes: HashMap<u64, HnswNode>,
    refs_by_key: HashMap<u64, MemoryRef>,
    keys_by_ref: HashMap<MemoryRef, u64>,
    next_key: u64,
    dimensions: usize,

    /// Entry point node id (highest-level node).
    entry_point: Option<u64>,
    max_layer: usize,

    m: usize,
    m_max0: usize,
    ef_construction: usize,
    ef_search: usize,
    level_multiplier: f64,

    metric: DistanceMetric,

    /// Mirror of all vectors for brute-force fallback.
    exact: ExactMemoryVectorIndex,
}

impl HnswMemoryVectorIndex {
    pub fn new(dimensions: usize) -> MemoryResult<Self> {
        Self::with_params(
            dimensions,
            DistanceMetric::Cosine,
            DEFAULT_M,
            DEFAULT_EF_CONSTRUCTION,
            DEFAULT_EF_SEARCH,
        )
    }

    pub fn with_params(
        dimensions: usize,
        metric: DistanceMetric,
        m: usize,
        ef_construction: usize,
        ef_search: usize,
    ) -> MemoryResult<Self> {
        if dimensions == 0 {
            return Err(MemoryError::validation(
                "vector index dimensions must not be zero",
            ));
        }
        let level_multiplier = if m > 1 { 1.0 / (m as f64).ln() } else { 1.0 };
        Ok(Self {
            nodes: HashMap::new(),
            refs_by_key: HashMap::new(),
            keys_by_ref: HashMap::new(),
            next_key: 1,
            dimensions,
            entry_point: None,
            max_layer: 0,
            m,
            m_max0: m * 2,
            ef_construction,
            ef_search,
            level_multiplier,
            metric,
            exact: ExactMemoryVectorIndex::default(),
        })
    }

    pub fn from_embeddings<I>(embeddings: I) -> MemoryResult<Option<Self>>
    where
        I: IntoIterator<Item = (MemoryRef, Vec<f32>)>,
    {
        let mut iter = embeddings.into_iter();
        let Some((first_ref, first_vector)) = iter.next() else {
            return Ok(None);
        };
        let mut index = Self::new(first_vector.len())?;
        index.upsert(&first_ref, &first_vector)?;
        for (memory_ref, vector) in iter {
            index.upsert(&memory_ref, &vector)?;
        }
        Ok(Some(index))
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    // -- internal helpers --------------------------------------------------

    fn next_key(&mut self) -> u64 {
        let key = self.next_key;
        self.next_key = self.next_key.saturating_add(1).max(1);
        key
    }

    fn random_level(&self) -> usize {
        let r: f64 = rand::random::<f64>().max(f64::EPSILON);
        (-r.ln() * self.level_multiplier) as usize
    }

    fn node_vector(&self, id: u64) -> Option<&[f32]> {
        self.nodes.get(&id).map(|n| n.vector.as_slice())
    }

    fn distance(&self, a: &[f32], node_id: u64) -> f32 {
        if let Some(v) = self.node_vector(node_id) {
            compute_distance(a, v, self.metric)
        } else {
            f32::MAX
        }
    }

    /// Search a single layer for the `ef` nearest neighbors to `query`.
    fn search_layer(
        &self,
        query: &[f32],
        entry_points: &[u64],
        ef: usize,
        layer: usize,
    ) -> Vec<(u64, f32)> {
        let mut visited: HashSet<u64> = entry_points.iter().copied().collect();

        // candidates: min-heap by distance
        let mut candidates: BinaryHeap<std::cmp::Reverse<(OrderedF32, u64)>> = BinaryHeap::new();
        // results: max-heap by distance (worst on top for easy pruning)
        let mut results: BinaryHeap<(OrderedF32, u64)> = BinaryHeap::new();

        for &ep in entry_points {
            let dist = self.distance(query, ep);
            candidates.push(std::cmp::Reverse((OrderedF32(dist), ep)));
            results.push((OrderedF32(dist), ep));
        }

        while let Some(std::cmp::Reverse((OrderedF32(c_dist), c_id))) = candidates.pop() {
            let worst_dist = results.peek().map(|(d, _)| d.0).unwrap_or(f32::MAX);
            if c_dist > worst_dist && results.len() >= ef {
                break;
            }

            let neighbors = self
                .nodes
                .get(&c_id)
                .and_then(|n| n.neighbors.get(layer))
                .cloned()
                .unwrap_or_default();

            for neighbor in neighbors {
                if !visited.insert(neighbor) {
                    continue;
                }
                let n_dist = self.distance(query, neighbor);
                let worst_dist = results.peek().map(|(d, _)| d.0).unwrap_or(f32::MAX);

                if n_dist < worst_dist || results.len() < ef {
                    candidates.push(std::cmp::Reverse((OrderedF32(n_dist), neighbor)));
                    results.push((OrderedF32(n_dist), neighbor));
                    if results.len() > ef {
                        results.pop();
                    }
                }
            }
        }

        let mut out: Vec<(u64, f32)> = results.into_iter().map(|(d, id)| (id, d.0)).collect();
        out.sort_by(|a, b| a.1.total_cmp(&b.1));
        out
    }

    /// Greedy find the closest node at `layer` starting from `entry_points`.
    fn greedy_closest(&self, query: &[f32], entry_points: &[u64], layer: usize) -> Vec<u64> {
        let mut current = entry_points.to_vec();

        loop {
            let mut best_id = *current.first().unwrap();
            let mut best_dist = self.distance(query, best_id);
            let mut improved = false;

            for &c in &current {
                let d = self.distance(query, c);
                if d < best_dist {
                    best_dist = d;
                    best_id = c;
                    improved = true;
                }
            }

            if !improved {
                return current;
            }

            let next = self
                .nodes
                .get(&best_id)
                .and_then(|n| n.neighbors.get(layer))
                .cloned()
                .unwrap_or_default();

            if next.is_empty() {
                return vec![best_id];
            }
            current = next;
        }
    }

    /// Select up to `max_neighbors` from candidates, preferring diverse connections.
    fn select_neighbors(
        &self,
        _query: &[f32],
        candidates: &[(u64, f32)],
        max_neighbors: usize,
    ) -> Vec<u64> {
        let mut selected: Vec<u64> = Vec::new();
        let mut selected_set: HashSet<u64> = HashSet::new();

        for &(cand_id, cand_dist) in candidates {
            if selected.len() >= max_neighbors {
                break;
            }
            if selected_set.contains(&cand_id) {
                continue;
            }

            let cand_vec = match self.node_vector(cand_id) {
                Some(v) => v,
                None => continue,
            };

            // Skip if this candidate is closer to an already-selected neighbor
            // than to the query (heuristic for diverse neighbors).
            let mut redundant = false;
            for &sel_id in &selected {
                if let Some(sel_vec) = self.node_vector(sel_id)
                    && compute_distance(cand_vec, sel_vec, self.metric) < cand_dist
                {
                    redundant = true;
                    break;
                }
            }
            if !redundant {
                selected.push(cand_id);
                selected_set.insert(cand_id);
            }
        }

        // Fill remaining slots with closest candidates if heuristic was too aggressive.
        if selected.len() < max_neighbors {
            for &(cand_id, _) in candidates {
                if selected.len() >= max_neighbors {
                    break;
                }
                if selected_set.insert(cand_id) {
                    selected.push(cand_id);
                }
            }
        }

        selected
    }

    /// Insert a single vector into the HNSW graph.
    fn insert_internal(&mut self, key: u64, vector: &[f32]) {
        let level = self.random_level();
        let node_neighbors: Vec<Vec<u64>> = (0..=level).map(|_| Vec::new()).collect();

        self.nodes.insert(
            key,
            HnswNode {
                vector: vector.to_vec(),
                neighbors: node_neighbors,
            },
        );

        let Some(entry) = self.entry_point else {
            self.entry_point = Some(key);
            self.max_layer = level;
            return;
        };

        let mut entry_points = vec![entry];

        // Phase 1: greedily descend from top layer to `level + 1`.
        if level < self.max_layer {
            for layer in ((level + 1)..=self.max_layer).rev() {
                entry_points = self.greedy_closest(vector, &entry_points, layer);
                entry_points.truncate(1);
            }
        }

        // Phase 2: at each layer from min(level, max_layer) down to 0,
        // search and connect.
        let start_layer = level.min(self.max_layer);
        for layer in (0..=start_layer).rev() {
            let max_conn = if layer == 0 { self.m_max0 } else { self.m };

            let candidates = self.search_layer(vector, &entry_points, self.ef_construction, layer);

            let neighbors = self.select_neighbors(vector, &candidates, max_conn);

            // Set this node's neighbors at this layer.
            if let Some(node) = self.nodes.get_mut(&key)
                && layer < node.neighbors.len()
            {
                node.neighbors[layer] = neighbors.clone();
            }

            // Add bidirectional connections (split to avoid borrow issues).
            for &neighbor_id in &neighbors {
                self.add_reverse_connection(neighbor_id, key, layer, max_conn);
            }

            entry_points = neighbors;
        }

        // Update entry point if this node has a higher level.
        if level > self.max_layer {
            self.entry_point = Some(key);
            self.max_layer = level;
        }
    }

    /// Add a reverse connection from `neighbor_id` back to `new_key` at `layer`,
    /// pruning if the neighbor exceeds `max_conn`.
    fn add_reverse_connection(
        &mut self,
        neighbor_id: u64,
        new_key: u64,
        layer: usize,
        max_conn: usize,
    ) {
        // Check whether we need to add the reverse edge.
        let should_add = self
            .nodes
            .get(&neighbor_id)
            .map(|n| layer < n.neighbors.len() && !n.neighbors[layer].contains(&new_key))
            .unwrap_or(false);

        if !should_add {
            return;
        }

        // Add the reverse edge.
        let needs_prune = {
            let neighbor_node = self.nodes.get_mut(&neighbor_id).unwrap();
            neighbor_node.neighbors[layer].push(new_key);
            neighbor_node.neighbors[layer].len() > max_conn
        };

        if !needs_prune {
            return;
        }

        // Prune: collect ids + neighbor vector without holding mutable borrow.
        let (neighbor_ids, n_vec) = {
            let neighbor_node = self.nodes.get(&neighbor_id).unwrap();
            (
                neighbor_node.neighbors[layer].clone(),
                neighbor_node.vector.clone(),
            )
        };

        let metric = self.metric;
        let mut scored: Vec<(u64, f32)> = neighbor_ids
            .iter()
            .map(|&id| {
                let dist = self
                    .nodes
                    .get(&id)
                    .map(|n| compute_distance(&n_vec, &n.vector, metric))
                    .unwrap_or(f32::MAX);
                (id, dist)
            })
            .collect();
        scored.sort_by(|a, b| a.1.total_cmp(&b.1));
        scored.truncate(max_conn);

        let pruned: Vec<u64> = scored.into_iter().map(|(id, _)| id).collect();
        if let Some(neighbor_node) = self.nodes.get_mut(&neighbor_id)
            && layer < neighbor_node.neighbors.len()
        {
            neighbor_node.neighbors[layer] = pruned;
        }
    }

    /// Convert distance to similarity score (matching the existing API).
    fn distance_to_score(&self, distance: f32) -> f32 {
        match self.metric {
            DistanceMetric::Cosine => 1.0 - distance,
            DistanceMetric::Euclidean => {
                if distance <= 0.0 {
                    1.0
                } else {
                    1.0 / (1.0 + distance)
                }
            }
        }
    }

    /// Brute-force exact search using the configured distance metric.
    fn exact_search_with_metric(
        &self,
        query: &[f32],
        limit: usize,
    ) -> MemoryResult<Vec<VectorHit>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut hits: Vec<VectorHit> = self
            .exact
            .vectors
            .iter()
            .filter_map(|(memory_ref, vector)| {
                if vector.len() != query.len() {
                    return None;
                }
                let dist = compute_distance(query, vector, self.metric);
                let score = self.distance_to_score(dist);
                if score.abs() < f32::EPSILON && dist > 1e30 {
                    None
                } else {
                    Some(VectorHit {
                        memory_ref: memory_ref.clone(),
                        score,
                    })
                }
            })
            .collect();
        hits.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| a.memory_ref.to_string().cmp(&b.memory_ref.to_string()))
        });
        hits.truncate(limit);
        Ok(hits)
    }

    fn hnsw_search(&self, query: &[f32], limit: usize) -> MemoryResult<Vec<VectorHit>> {
        if limit == 0 || self.nodes.is_empty() {
            return Ok(Vec::new());
        }

        let Some(entry) = self.entry_point else {
            return Ok(Vec::new());
        };

        let mut entry_points = vec![entry];

        // Greedy descend from top layer to layer 1.
        for layer in (1..=self.max_layer).rev() {
            entry_points = self.greedy_closest(query, &entry_points, layer);
            entry_points.truncate(1);
        }

        // Search layer 0 with ef = max(ef_search, limit).
        let ef = self.ef_search.max(limit);
        let candidates = self.search_layer(query, &entry_points, ef, 0);

        let mut hits: Vec<VectorHit> = candidates
            .into_iter()
            .filter_map(|(key, dist)| {
                self.refs_by_key.get(&key).map(|memory_ref| VectorHit {
                    memory_ref: memory_ref.clone(),
                    score: self.distance_to_score(dist),
                })
            })
            .collect();

        hits.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| a.memory_ref.to_string().cmp(&b.memory_ref.to_string()))
        });
        hits.truncate(limit);
        Ok(hits)
    }
}

impl MemoryVectorIndex for HnswMemoryVectorIndex {
    fn upsert(&mut self, memory_ref: &MemoryRef, embedding: &[f32]) -> MemoryResult<()> {
        validate_embedding(embedding)?;
        if embedding.len() != self.dimensions {
            return Err(MemoryError::validation(format!(
                "embedding vector dimensions mismatch: expected {}, got {}",
                self.dimensions,
                embedding.len()
            )));
        }

        // Always update the exact mirror for fallback.
        self.exact.upsert(memory_ref, embedding)?;

        // If already present, remove the old HNSW node before re-inserting.
        if let Some(old_key) = self.keys_by_ref.remove(memory_ref) {
            self.nodes.remove(&old_key);
            self.refs_by_key.remove(&old_key);
            // Clean neighbor references pointing to old_key.
            for node in self.nodes.values_mut() {
                for layer_neighbors in &mut node.neighbors {
                    layer_neighbors.retain(|&id| id != old_key);
                }
            }
            if self.entry_point == Some(old_key) {
                self.entry_point = self.nodes.keys().next().copied();
                if let Some(ep) = self.entry_point {
                    self.max_layer = self.nodes[&ep].neighbors.len() - 1;
                } else {
                    self.max_layer = 0;
                }
            }
        }

        let key = self.next_key();
        self.insert_internal(key, embedding);
        self.refs_by_key.insert(key, memory_ref.clone());
        self.keys_by_ref.insert(memory_ref.clone(), key);

        Ok(())
    }

    fn delete(&mut self, memory_ref: &MemoryRef) -> MemoryResult<()> {
        self.exact.delete(memory_ref)?;

        let Some(key) = self.keys_by_ref.remove(memory_ref) else {
            return Ok(());
        };
        self.nodes.remove(&key);
        self.refs_by_key.remove(&key);

        // Remove stale neighbor references.
        for node in self.nodes.values_mut() {
            for layer_neighbors in &mut node.neighbors {
                layer_neighbors.retain(|&id| id != key);
            }
        }

        // Update entry point if needed.
        if self.entry_point == Some(key) {
            self.entry_point = self.nodes.keys().next().copied();
            if let Some(ep) = self.entry_point {
                self.max_layer = self.nodes[&ep].neighbors.len() - 1;
            } else {
                self.max_layer = 0;
            }
        }

        Ok(())
    }

    fn search(&self, query: &[f32], limit: usize) -> MemoryResult<Vec<VectorHit>> {
        validate_embedding(query)?;
        if query.len() != self.dimensions {
            return Err(MemoryError::validation(format!(
                "query vector dimensions mismatch: expected {}, got {}",
                self.dimensions,
                query.len()
            )));
        }

        // Fall back to exact search for small datasets using the configured metric.
        if self.len() < HNSW_FALLBACK_THRESHOLD {
            return self.exact_search_with_metric(query, limit);
        }

        self.hnsw_search(query, limit)
    }
}

// ---------------------------------------------------------------------------
// MemoryVectorIndexCache — dispatch layer with automatic fallback
// ---------------------------------------------------------------------------

pub enum MemoryVectorIndexCache {
    Hnsw(HnswMemoryVectorIndex),
    #[cfg(feature = "usearch-index")]
    Usearch(UsearchMemoryVectorIndex),
    #[cfg(feature = "usearch-index")]
    PendingUsearch,
    Exact(ExactMemoryVectorIndex),
}

impl MemoryVectorIndexCache {
    pub fn from_embeddings<I>(embeddings: I) -> MemoryResult<Self>
    where
        I: IntoIterator<Item = (MemoryRef, Vec<f32>)>,
    {
        // Collect so we can check count and reuse.
        let collected: Vec<(MemoryRef, Vec<f32>)> = embeddings.into_iter().collect();

        if collected.is_empty() {
            return Ok(Self::Exact(ExactMemoryVectorIndex::default()));
        }

        // For small datasets, use exact search (brute-force is faster).
        if collected.len() < HNSW_FALLBACK_THRESHOLD {
            return ExactMemoryVectorIndex::from_embeddings(collected).map(Self::Exact);
        }

        // Build HNSW index.
        let mut iter = collected.into_iter();
        if let Some((first_ref, first_vec)) = iter.next() {
            let mut index = HnswMemoryVectorIndex::new(first_vec.len())?;
            index.upsert(&first_ref, &first_vec)?;
            for (r, v) in iter {
                index.upsert(&r, &v)?;
            }
            Ok(Self::Hnsw(index))
        } else {
            Ok(Self::Exact(ExactMemoryVectorIndex::default()))
        }
    }

    pub fn backend_name(&self) -> &'static str {
        match self {
            Self::Hnsw(_) => "hnsw",
            #[cfg(feature = "usearch-index")]
            Self::Usearch(_) => "usearch",
            #[cfg(feature = "usearch-index")]
            Self::PendingUsearch => "usearch-pending",
            Self::Exact(_) => "exact",
        }
    }
}

impl MemoryVectorIndex for MemoryVectorIndexCache {
    fn upsert(&mut self, memory_ref: &MemoryRef, embedding: &[f32]) -> MemoryResult<()> {
        match self {
            Self::Hnsw(index) => index.upsert(memory_ref, embedding),
            #[cfg(feature = "usearch-index")]
            Self::Usearch(index) => index.upsert(memory_ref, embedding),
            #[cfg(feature = "usearch-index")]
            Self::PendingUsearch => {
                let mut index = UsearchMemoryVectorIndex::new(embedding.len())?;
                index.upsert(memory_ref, embedding)?;
                *self = Self::Usearch(index);
                Ok(())
            }
            Self::Exact(index) => index.upsert(memory_ref, embedding),
        }
    }

    fn delete(&mut self, memory_ref: &MemoryRef) -> MemoryResult<()> {
        match self {
            Self::Hnsw(index) => index.delete(memory_ref),
            #[cfg(feature = "usearch-index")]
            Self::Usearch(index) => index.delete(memory_ref),
            #[cfg(feature = "usearch-index")]
            Self::PendingUsearch => Ok(()),
            Self::Exact(index) => index.delete(memory_ref),
        }
    }

    fn search(&self, query: &[f32], limit: usize) -> MemoryResult<Vec<VectorHit>> {
        match self {
            Self::Hnsw(index) => index.search(query, limit),
            #[cfg(feature = "usearch-index")]
            Self::Usearch(index) => index.search(query, limit),
            #[cfg(feature = "usearch-index")]
            Self::PendingUsearch => {
                validate_embedding(query)?;
                Ok(Vec::new())
            }
            Self::Exact(index) => index.search(query, limit),
        }
    }
}

// ---------------------------------------------------------------------------
// Usearch backend (optional, kept for backward compatibility)
// ---------------------------------------------------------------------------

#[cfg(feature = "usearch-index")]
pub struct UsearchMemoryVectorIndex {
    index: usearch::Index,
    refs_by_key: HashMap<u64, MemoryRef>,
    keys_by_ref: HashMap<MemoryRef, u64>,
    next_key: u64,
    dimensions: usize,
}

#[cfg(feature = "usearch-index")]
impl UsearchMemoryVectorIndex {
    pub fn new(dimensions: usize) -> MemoryResult<Self> {
        if dimensions == 0 {
            return Err(MemoryError::validation(
                "vector index dimensions must not be zero",
            ));
        }
        let index = usearch::new_index(&usearch::IndexOptions {
            dimensions,
            metric: usearch::MetricKind::Cos,
            quantization: usearch::ScalarKind::F32,
            ..Default::default()
        })
        .map_err(|error| MemoryError::Store(format!("usearch index init failed: {error}")))?;
        Ok(Self {
            index,
            refs_by_key: HashMap::new(),
            keys_by_ref: HashMap::new(),
            next_key: 1,
            dimensions,
        })
    }

    pub fn from_embeddings<I>(embeddings: I) -> MemoryResult<Option<Self>>
    where
        I: IntoIterator<Item = (MemoryRef, Vec<f32>)>,
    {
        let mut iter = embeddings.into_iter();
        let Some((first_ref, first_vector)) = iter.next() else {
            return Ok(None);
        };
        let mut index = Self::new(first_vector.len())?;
        index.upsert(&first_ref, &first_vector)?;
        for (memory_ref, vector) in iter {
            index.upsert(&memory_ref, &vector)?;
        }
        Ok(Some(index))
    }

    fn next_available_key(&mut self) -> u64 {
        let key = self.next_key;
        self.next_key = self.next_key.saturating_add(1).max(1);
        key
    }
}

#[cfg(feature = "usearch-index")]
impl MemoryVectorIndex for UsearchMemoryVectorIndex {
    fn upsert(&mut self, memory_ref: &MemoryRef, embedding: &[f32]) -> MemoryResult<()> {
        validate_embedding(embedding)?;
        if embedding.len() != self.dimensions {
            return Err(MemoryError::validation(format!(
                "embedding vector dimensions mismatch: expected {}, got {}",
                self.dimensions,
                embedding.len()
            )));
        }

        let key = if let Some(key) = self.keys_by_ref.get(memory_ref).copied() {
            self.index
                .remove(key)
                .map_err(|error| MemoryError::Store(format!("usearch remove failed: {error}")))?;
            key
        } else {
            self.next_available_key()
        };

        self.index
            .reserve(self.refs_by_key.len() + 1)
            .map_err(|error| MemoryError::Store(format!("usearch reserve failed: {error}")))?;
        self.index
            .add(key, embedding)
            .map_err(|error| MemoryError::Store(format!("usearch add failed: {error}")))?;
        self.refs_by_key.insert(key, memory_ref.clone());
        self.keys_by_ref.insert(memory_ref.clone(), key);
        Ok(())
    }

    fn delete(&mut self, memory_ref: &MemoryRef) -> MemoryResult<()> {
        let Some(key) = self.keys_by_ref.remove(memory_ref) else {
            return Ok(());
        };
        self.index
            .remove(key)
            .map_err(|error| MemoryError::Store(format!("usearch remove failed: {error}")))?;
        self.refs_by_key.remove(&key);
        Ok(())
    }

    fn search(&self, query: &[f32], limit: usize) -> MemoryResult<Vec<VectorHit>> {
        validate_embedding(query)?;
        if query.len() != self.dimensions {
            return Err(MemoryError::validation(format!(
                "query vector dimensions mismatch: expected {}, got {}",
                self.dimensions,
                query.len()
            )));
        }
        if limit == 0 {
            return Ok(Vec::new());
        }

        let matches = self
            .index
            .search(query, limit)
            .map_err(|error| MemoryError::Store(format!("usearch search failed: {error}")))?;
        let mut hits: Vec<VectorHit> = matches
            .keys
            .iter()
            .zip(matches.distances.iter())
            .filter_map(|(key, distance)| {
                self.refs_by_key.get(key).map(|memory_ref| VectorHit {
                    memory_ref: memory_ref.clone(),
                    score: 1.0 - distance,
                })
            })
            .collect();
        hits.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| a.memory_ref.to_string().cmp(&b.memory_ref.to_string()))
        });
        hits.truncate(limit);
        Ok(hits)
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn validate_embedding(vector: &[f32]) -> MemoryResult<()> {
    if vector.is_empty() {
        return Err(MemoryError::validation(
            "embedding vector must not be empty",
        ));
    }
    if vector.iter().any(|value| !value.is_finite()) {
        return Err(MemoryError::validation("embedding vector must be finite"));
    }
    Ok(())
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> Option<f32> {
    if a.len() != b.len() {
        return None;
    }
    Some(cosine_similarity_unchecked(a, b))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use crate::{MemoryRef, MemoryRefKind, MemoryVectorIndex, UserId, WorkspaceId};
    use std::collections::HashSet;

    fn ref_for(key: &str) -> MemoryRef {
        MemoryRef::new(
            MemoryRefKind::Memory,
            UserId::new("user"),
            WorkspaceId::new("workspace"),
            key,
        )
    }

    // -- Exact index tests (unchanged) ------------------------------------

    #[test]
    fn exact_index_returns_hits_ranked_by_cosine_similarity() {
        let mut index = super::ExactMemoryVectorIndex::default();
        let close = ref_for("close");
        let far = ref_for("far");
        let orthogonal = ref_for("orthogonal");

        index.upsert(&far, &[0.6, 0.8]).expect("upsert far");
        index
            .upsert(&orthogonal, &[0.0, 1.0])
            .expect("upsert orthogonal");
        index.upsert(&close, &[1.0, 0.0]).expect("upsert close");

        let hits = index.search(&[1.0, 0.0], 3).expect("search");

        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].memory_ref, close);
        assert_eq!(hits[1].memory_ref, far);
        assert_eq!(hits[2].memory_ref, orthogonal);
        assert!(hits[0].score > hits[1].score);
        assert!(hits[1].score > hits[2].score);
    }

    #[test]
    fn exact_index_upsert_replaces_existing_vector_and_delete_removes_it() {
        let mut index = super::ExactMemoryVectorIndex::default();
        let memory_ref = ref_for("mutable");

        index.upsert(&memory_ref, &[0.0, 1.0]).expect("insert");
        index.upsert(&memory_ref, &[1.0, 0.0]).expect("replace");

        let hits = index.search(&[1.0, 0.0], 10).expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].memory_ref, memory_ref);
        assert!(hits[0].score > 0.99);

        index.delete(&memory_ref).expect("delete");
        assert!(index.search(&[1.0, 0.0], 10).expect("search").is_empty());
    }

    // -- HNSW index tests --------------------------------------------------

    #[test]
    fn hnsw_index_returns_hits_ranked_by_cosine_similarity() {
        let mut index = super::HnswMemoryVectorIndex::new(2).expect("index");
        let close = ref_for("close");
        let far = ref_for("far");
        let orthogonal = ref_for("orthogonal");

        index.upsert(&far, &[0.6, 0.8]).expect("upsert far");
        index
            .upsert(&orthogonal, &[0.0, 1.0])
            .expect("upsert orthogonal");
        index.upsert(&close, &[1.0, 0.0]).expect("upsert close");

        // Below threshold -> falls back to exact, results should match.
        let hits = index.search(&[1.0, 0.0], 3).expect("search");

        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].memory_ref, close);
        assert_eq!(hits[1].memory_ref, far);
        assert_eq!(hits[2].memory_ref, orthogonal);
        assert!(hits[0].score > hits[1].score);
        assert!(hits[1].score > hits[2].score);
    }

    #[test]
    fn hnsw_search_matches_exact_for_large_dataset() {
        use rand::Rng;

        let dims = 64;
        let n = 200; // above HNSW_FALLBACK_THRESHOLD
        let mut rng = rand::thread_rng();

        let mut hnsw = super::HnswMemoryVectorIndex::with_params(
            dims,
            super::DistanceMetric::Cosine,
            16,
            200,
            64,
        )
        .expect("hnsw init");

        let mut refs = Vec::new();
        let mut vectors = Vec::new();

        for i in 0..n {
            let r = ref_for(&format!("vec_{i}"));
            let v: Vec<f32> = (0..dims).map(|_| rng.gen_range(-1.0..1.0)).collect();
            hnsw.upsert(&r, &v).expect("upsert");
            refs.push(r);
            vectors.push(v);
        }

        let query: Vec<f32> = (0..dims).map(|_| rng.gen_range(-1.0..1.0)).collect();
        let limit = 10;

        // HNSW search (above threshold, uses ANN path).
        let hnsw_hits = hnsw.search(&query, limit).expect("hnsw search");
        assert_eq!(hnsw_hits.len(), limit);

        // Exact brute-force for ground truth.
        let mut exact_scores: Vec<(usize, f32)> = vectors
            .iter()
            .enumerate()
            .map(|(i, v)| (i, super::cosine_similarity_unchecked(&query, v)))
            .collect();
        exact_scores.sort_by(|a, b| b.1.total_cmp(&a.1));

        // Verify top-1 matches.
        let best_exact_ref = &refs[exact_scores[0].0];
        assert_eq!(
            hnsw_hits[0].memory_ref, *best_exact_ref,
            "HNSW top-1 should match exact top-1"
        );

        // Verify high recall in top-10: at least 7 of the exact top-10
        // should appear in HNSW top-10.
        let exact_top10_refs: HashSet<_> = exact_scores[..10]
            .iter()
            .map(|(i, _)| refs[*i].clone())
            .collect();
        let hnsw_top10_refs: HashSet<_> = hnsw_hits.iter().map(|h| h.memory_ref.clone()).collect();
        let recall = exact_top10_refs.intersection(&hnsw_top10_refs).count();
        assert!(
            recall >= 7,
            "HNSW recall too low: {recall}/10 (expected >= 7)"
        );
    }

    #[test]
    fn hnsw_incremental_insert_search_still_works() {
        let dims = 32;
        let mut index = super::HnswMemoryVectorIndex::with_params(
            dims,
            super::DistanceMetric::Cosine,
            8,
            100,
            32,
        )
        .expect("init");

        // Insert 150 vectors one at a time.
        for i in 0..150u32 {
            let r = ref_for(&format!("inc_{i}"));
            let v: Vec<f32> = (0..dims)
                .map(|j| ((i * 31 + j as u32) as f32) / 1000.0)
                .collect();
            index.upsert(&r, &v).expect("upsert");
        }

        assert_eq!(index.len(), 150);

        // Search should return results above the threshold.
        let query: Vec<f32> = (0..dims).map(|j| (j as f32) / 1000.0).collect();
        let hits = index.search(&query, 5).expect("search");
        assert_eq!(hits.len(), 5, "should return 5 hits");
        // Scores should be descending.
        for window in hits.windows(2) {
            assert!(window[0].score >= window[1].score);
        }
    }

    #[test]
    fn hnsw_fallback_to_exact_for_small_datasets() {
        let mut index = super::HnswMemoryVectorIndex::new(4).expect("init");

        // Insert fewer than HNSW_FALLBACK_THRESHOLD vectors.
        // Use diverse directions so cosine ranking is well-defined.
        let directions: Vec<[f32; 4]> = vec![
            [1.0, 0.0, 0.0, 0.0],
            [0.9, 0.1, 0.0, 0.0],
            [0.8, 0.2, 0.0, 0.0],
            [0.7, 0.3, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
            [0.5, 0.5, 0.0, 0.0],
            [0.3, 0.7, 0.0, 0.0],
            [0.1, 0.9, 0.0, 0.0],
        ];
        for i in 0..50u32 {
            let r = ref_for(&format!("small_{i}"));
            let dir = directions[(i as usize) % directions.len()];
            let scale = 1.0 + (i as f32) * 0.01;
            let v: Vec<f32> = dir.iter().map(|x| x * scale).collect();
            index.upsert(&r, &v).expect("upsert");
        }

        // Search with a query close to [1, 0, 0, 0].
        // small_0 has direction [1, 0, 0, 0] -> should be top hit.
        let hits = index.search(&[1.0, 0.0, 0.0, 0.0], 5).expect("search");
        assert_eq!(hits.len(), 5);
        // First hit should be small_0 (exact direction match).
        assert_eq!(hits[0].memory_ref, ref_for("small_0"));
        // Scores should be non-increasing.
        for window in hits.windows(2) {
            assert!(window[0].score >= window[1].score);
        }
    }

    #[test]
    fn hnsw_euclidean_distance_metric() {
        let mut index = super::HnswMemoryVectorIndex::with_params(
            3,
            super::DistanceMetric::Euclidean,
            8,
            100,
            32,
        )
        .expect("init");

        let near = ref_for("near");
        let mid = ref_for("mid");
        let far = ref_for("far");

        // Euclidean: use vectors at different distances from the origin.
        index.upsert(&near, &[0.1, 0.0, 0.0]).expect("upsert");
        index.upsert(&mid, &[5.0, 0.0, 0.0]).expect("upsert");
        index.upsert(&far, &[100.0, 0.0, 0.0]).expect("upsert");

        // Below threshold -> exact fallback with euclidean scoring.
        let hits = index.search(&[0.0, 0.0, 0.0], 3).expect("search");
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].memory_ref, near);
        assert_eq!(hits[1].memory_ref, mid);
        assert_eq!(hits[2].memory_ref, far);
        assert!(hits[0].score > hits[1].score);
        assert!(hits[1].score > hits[2].score);
    }

    #[test]
    fn hnsw_upsert_replaces_and_delete_removes() {
        let mut index = super::HnswMemoryVectorIndex::new(2).expect("init");
        let r = ref_for("mutable");

        index.upsert(&r, &[0.0, 1.0]).expect("insert");
        index.upsert(&r, &[1.0, 0.0]).expect("replace");

        let hits = index.search(&[1.0, 0.0], 10).expect("search");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].score > 0.99);

        index.delete(&r).expect("delete");
        assert!(index.search(&[1.0, 0.0], 10).expect("search").is_empty());
    }

    #[test]
    fn hnsw_empty_search_returns_empty() {
        let index = super::HnswMemoryVectorIndex::new(4).expect("init");
        let hits = index.search(&[1.0, 0.0, 0.0, 0.0], 5).expect("search");
        assert!(hits.is_empty());
    }

    #[test]
    fn hnsw_dimension_mismatch_errors() {
        let mut index = super::HnswMemoryVectorIndex::new(4).expect("init");
        let r = ref_for("bad");
        assert!(index.upsert(&r, &[1.0, 2.0]).is_err());
        index.upsert(&r, &[1.0, 2.0, 3.0, 4.0]).expect("ok");
        assert!(index.search(&[1.0, 2.0], 1).is_err());
    }

    #[test]
    fn cache_from_embeddings_uses_exact_for_small_and_hnsw_for_large() {
        use super::MemoryVectorIndexCache;

        // Small -> exact.
        let small: Vec<_> = (0..10)
            .map(|i| (ref_for(&format!("s{i}")), vec![i as f32, 0.0]))
            .collect();
        let cache = MemoryVectorIndexCache::from_embeddings(small).expect("small");
        assert_eq!(cache.backend_name(), "exact");

        // Large -> hnsw.
        let large: Vec<_> = (0..150)
            .map(|i| (ref_for(&format!("l{i}")), vec![i as f32, 0.0]))
            .collect();
        let cache = MemoryVectorIndexCache::from_embeddings(large).expect("large");
        assert_eq!(cache.backend_name(), "hnsw");
    }

    #[cfg(feature = "usearch-index")]
    #[test]
    fn usearch_index_returns_hits_ranked_by_cosine_similarity() {
        let mut index = super::UsearchMemoryVectorIndex::new(2).expect("index");
        let close = ref_for("close");
        let far = ref_for("far");
        let orthogonal = ref_for("orthogonal");

        index.upsert(&far, &[0.6, 0.8]).expect("upsert far");
        index
            .upsert(&orthogonal, &[0.0, 1.0])
            .expect("upsert orthogonal");
        index.upsert(&close, &[1.0, 0.0]).expect("upsert close");

        let hits = index.search(&[1.0, 0.0], 3).expect("search");

        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].memory_ref, close);
        assert_eq!(hits[1].memory_ref, far);
        assert_eq!(hits[2].memory_ref, orthogonal);
        assert!(hits[0].score > hits[1].score);
        assert!(hits[1].score > hits[2].score);
    }

    // -- Benchmarks (run with: cargo test -p local-first-memory --lib vector_index -- --nocapture) --

    #[test]
    fn bench_hnsw_vs_exact_search_timing() {
        use rand::Rng;
        use std::time::Instant;

        let dims = 128;
        let n = 2_000;
        let queries = 50;
        let limit = 10;
        let mut rng = rand::thread_rng();

        // Build dataset.
        let data: Vec<(crate::MemoryRef, Vec<f32>)> = (0..n)
            .map(|i| {
                let r = ref_for(&format!("bench_{i}"));
                let v: Vec<f32> = (0..dims).map(|_| rng.gen_range(-1.0..1.0)).collect();
                (r, v)
            })
            .collect();
        let query_vecs: Vec<Vec<f32>> = (0..queries)
            .map(|_| (0..dims).map(|_| rng.gen_range(-1.0..1.0)).collect())
            .collect();

        // Exact index.
        let mut exact = super::ExactMemoryVectorIndex::default();
        for (r, v) in &data {
            exact.upsert(r, v).unwrap();
        }
        let exact_start = Instant::now();
        for q in &query_vecs {
            let _ = exact.search(q, limit).unwrap();
        }
        let exact_elapsed = exact_start.elapsed();

        // HNSW index (above threshold so ANN path is used).
        let mut hnsw = super::HnswMemoryVectorIndex::with_params(
            dims,
            super::DistanceMetric::Cosine,
            16,
            200,
            64,
        )
        .unwrap();
        for (r, v) in &data {
            hnsw.upsert(r, v).unwrap();
        }
        let hnsw_start = Instant::now();
        for q in &query_vecs {
            let _ = hnsw.search(q, limit).unwrap();
        }
        let hnsw_elapsed = hnsw_start.elapsed();

        println!("\n[bench] n={n} dims={dims} queries={queries} limit={limit}");
        println!(
            "  exact  : {:?} total  ({:.1} us/query)",
            exact_elapsed,
            exact_elapsed.as_micros() as f64 / queries as f64
        );
        println!(
            "  hnsw   : {:?} total  ({:.1} us/query)",
            hnsw_elapsed,
            hnsw_elapsed.as_micros() as f64 / queries as f64
        );
        if hnsw_elapsed < exact_elapsed {
            let speedup = exact_elapsed.as_secs_f64() / hnsw_elapsed.as_secs_f64().max(1e-9);
            println!("  speedup: {speedup:.2}x");
        } else {
            println!("  (hnsw slower at this size — expected for small n)");
        }
    }
}
