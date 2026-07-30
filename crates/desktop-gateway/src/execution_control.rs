use std::sync::atomic::{AtomicU8, Ordering};
use tokio::sync::Notify;

const CANCELLED: u8 = 1 << 0;
const LEASE_LOST: u8 = 1 << 1;
const DEADLINE_EXCEEDED: u8 = 1 << 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExecutionInterruption {
    Cancelled,
    LeaseLost,
    DeadlineExceeded,
}

/// Volatile stop signal for one running execution attempt.
///
/// Durable ownership remains in the task store and execution journal. This
/// object only lets work already dispatched observe that authority promptly.
#[derive(Default)]
pub(crate) struct ExecutionAttemptControl {
    signals: AtomicU8,
    notify: Notify,
}

impl ExecutionAttemptControl {
    pub(crate) fn signal(&self, interruption: ExecutionInterruption) {
        let bit = match interruption {
            ExecutionInterruption::Cancelled => CANCELLED,
            ExecutionInterruption::LeaseLost => LEASE_LOST,
            ExecutionInterruption::DeadlineExceeded => DEADLINE_EXCEEDED,
        };
        self.signals.fetch_or(bit, Ordering::AcqRel);
        self.notify.notify_waiters();
    }

    pub(crate) fn interruption(&self) -> Option<ExecutionInterruption> {
        let signals = self.signals.load(Ordering::Acquire);
        if signals & CANCELLED != 0 {
            Some(ExecutionInterruption::Cancelled)
        } else if signals & LEASE_LOST != 0 {
            Some(ExecutionInterruption::LeaseLost)
        } else if signals & DEADLINE_EXCEEDED != 0 {
            Some(ExecutionInterruption::DeadlineExceeded)
        } else {
            None
        }
    }

    pub(crate) async fn interrupted(&self) -> ExecutionInterruption {
        loop {
            let notified = self.notify.notified();
            if let Some(interruption) = self.interruption() {
                return interruption;
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ExecutionAttemptControl, ExecutionInterruption};

    #[test]
    fn canonical_precedence_is_cancel_then_lease_then_deadline() {
        let control = ExecutionAttemptControl::default();
        control.signal(ExecutionInterruption::DeadlineExceeded);
        assert_eq!(
            control.interruption(),
            Some(ExecutionInterruption::DeadlineExceeded)
        );
        control.signal(ExecutionInterruption::LeaseLost);
        assert_eq!(
            control.interruption(),
            Some(ExecutionInterruption::LeaseLost)
        );
        control.signal(ExecutionInterruption::Cancelled);
        assert_eq!(
            control.interruption(),
            Some(ExecutionInterruption::Cancelled)
        );
    }
}
