"""Persist job observations independently from viewer authorization."""
from copy import deepcopy
from homun.domain.models import utc_now
from homun.application.terminal_contracts import public


def record(ctx, proposal_id, snapshot, state):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            proposal = store.commands[proposal_id].result
            if proposal.get('_io_epoch') == snapshot.get('_io_epoch'):
                # Persist evidence independently of current viewer authority.
                proposal.update({k:v for k,v in state.items() if k != 'container_id'})
                if state['status'] != 'outcome_unknown' and not state.get('error_code'):
                    proposal.pop('error',None)
                    proposal.pop('error_code',None)
                proposal['_observed_at'] = utc_now().isoformat()
            response = deepcopy(public(proposal))
        ctx.service.store = store
    return response
