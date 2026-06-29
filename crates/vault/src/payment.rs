use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaymentApprovalSnapshot {
    pub approval_id: String,
    pub merchant: String,
    pub domain: String,
    /// Minor units, e.g. cents.
    pub amount_minor: i64,
    pub currency: String,
    pub product_summary: String,
    pub payment_method_label: String,
    pub checkout_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentApprovalDecision {
    Valid,
    Invalidated { field: &'static str },
}

pub fn validate_payment_approval(
    approved: &PaymentApprovalSnapshot,
    current: &PaymentApprovalSnapshot,
) -> PaymentApprovalDecision {
    if approved.merchant != current.merchant {
        return PaymentApprovalDecision::Invalidated { field: "merchant" };
    }
    if approved.domain != current.domain {
        return PaymentApprovalDecision::Invalidated { field: "domain" };
    }
    if approved.amount_minor != current.amount_minor {
        return PaymentApprovalDecision::Invalidated { field: "amount" };
    }
    if approved.currency != current.currency {
        return PaymentApprovalDecision::Invalidated { field: "currency" };
    }
    if approved.product_summary != current.product_summary {
        return PaymentApprovalDecision::Invalidated { field: "product" };
    }
    if approved.payment_method_label != current.payment_method_label {
        return PaymentApprovalDecision::Invalidated { field: "method" };
    }
    if approved.checkout_fingerprint != current.checkout_fingerprint {
        return PaymentApprovalDecision::Invalidated {
            field: "fingerprint",
        };
    }
    PaymentApprovalDecision::Valid
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> PaymentApprovalSnapshot {
        PaymentApprovalSnapshot {
            approval_id: "pay_1".to_string(),
            merchant: "Trainline".to_string(),
            domain: "www.thetrainline.com".to_string(),
            amount_minor: 5900,
            currency: "EUR".to_string(),
            product_summary: "Napoli -> Roma 2026-07-10 09:50".to_string(),
            payment_method_label: "Visa 1111".to_string(),
            checkout_fingerprint: "checkout_hash_a".to_string(),
        }
    }

    #[test]
    fn payment_approval_accepts_identical_checkout_snapshot() {
        let approved = snapshot();
        let current = snapshot();

        assert_eq!(
            validate_payment_approval(&approved, &current),
            PaymentApprovalDecision::Valid
        );
    }

    #[test]
    fn payment_approval_invalidates_on_checkout_change() {
        let approved = snapshot();
        let cases = [
            (
                "merchant",
                PaymentApprovalSnapshot {
                    merchant: "Other".to_string(),
                    ..snapshot()
                },
            ),
            (
                "domain",
                PaymentApprovalSnapshot {
                    domain: "evil.test".to_string(),
                    ..snapshot()
                },
            ),
            (
                "amount",
                PaymentApprovalSnapshot {
                    amount_minor: 6400,
                    ..snapshot()
                },
            ),
            (
                "currency",
                PaymentApprovalSnapshot {
                    currency: "USD".to_string(),
                    ..snapshot()
                },
            ),
            (
                "product",
                PaymentApprovalSnapshot {
                    product_summary: "Napoli -> Roma 2026-07-10 10:55".to_string(),
                    ..snapshot()
                },
            ),
            (
                "method",
                PaymentApprovalSnapshot {
                    payment_method_label: "Mastercard 2222".to_string(),
                    ..snapshot()
                },
            ),
            (
                "fingerprint",
                PaymentApprovalSnapshot {
                    checkout_fingerprint: "checkout_hash_b".to_string(),
                    ..snapshot()
                },
            ),
        ];

        for (field, current) in cases {
            assert_eq!(
                validate_payment_approval(&approved, &current),
                PaymentApprovalDecision::Invalidated { field },
                "{field} should invalidate payment approval"
            );
        }
    }
}
