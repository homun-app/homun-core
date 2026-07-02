use crate::{MemoryError, MemoryRef, MemoryResult};
use std::collections::HashMap;

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

pub enum MemoryVectorIndexCache {
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
        #[cfg(feature = "usearch-index")]
        {
            return UsearchMemoryVectorIndex::from_embeddings(embeddings)
                .map(|index| index.map(Self::Usearch).unwrap_or(Self::PendingUsearch));
        }

        #[cfg(not(feature = "usearch-index"))]
        {
            ExactMemoryVectorIndex::from_embeddings(embeddings).map(Self::Exact)
        }
    }

    pub fn backend_name(&self) -> &'static str {
        match self {
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
            #[cfg(feature = "usearch-index")]
            Self::Usearch(index) => index.delete(memory_ref),
            #[cfg(feature = "usearch-index")]
            Self::PendingUsearch => Ok(()),
            Self::Exact(index) => index.delete(memory_ref),
        }
    }

    fn search(&self, query: &[f32], limit: usize) -> MemoryResult<Vec<VectorHit>> {
        match self {
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
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for (left, right) in a.iter().zip(b) {
        dot += left * right;
        norm_a += left * left;
        norm_b += right * right;
    }
    if norm_a <= f32::EPSILON || norm_b <= f32::EPSILON {
        return None;
    }
    Some(dot / (norm_a.sqrt() * norm_b.sqrt()))
}

#[cfg(test)]
mod tests {
    use crate::{MemoryRef, MemoryRefKind, MemoryVectorIndex, UserId, WorkspaceId};

    fn ref_for(key: &str) -> MemoryRef {
        MemoryRef::new(
            MemoryRefKind::Memory,
            UserId::new("user"),
            WorkspaceId::new("workspace"),
            key,
        )
    }

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
}
