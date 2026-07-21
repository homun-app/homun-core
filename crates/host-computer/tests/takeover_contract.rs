use local_first_host_computer::protocol::{HostInputEvent, TakeoverPhase, TakeoverState};

#[test]
fn physical_input_invalidates_current_resume_token() {
    let mut state = TakeoverState::active("resume-1");
    state.apply(HostInputEvent::PhysicalMouseDown);

    assert_eq!(state.phase, TakeoverPhase::PausedByUser);
    assert!(!state.accepts("resume-1"));
}

#[test]
fn homun_events_do_not_trigger_takeover_and_lock_is_fail_closed() {
    let mut state = TakeoverState::active("resume-1");
    state.apply(HostInputEvent::HomunSynthetic);
    assert!(state.accepts("resume-1"));

    state.apply(HostInputEvent::HostLocked);
    assert_eq!(state.phase, TakeoverPhase::HostLocked);
    assert!(!state.accepts("resume-1"));
}
