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
}
