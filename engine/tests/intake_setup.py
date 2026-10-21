"""Shared setup: an intake agreement through the front-door commit path.

Quello che i test facevano con `intake.propose` (modello finto + POST) oggi è
la sequenza reale del turno di ingresso: il messaggio della persona entra in
trascrizione, il brief validato (gli argomenti di ``propose_work``) diventa la
proposta, la conferma è lo stesso endpoint della UI.
"""
from __future__ import annotations


def front_door_intake(ctx, actor, work_id, brief, *, command_id='intake', text='Confronta i listini',
                      confirm=True, create_agent=False):
    """Propone (e di default conferma) un accordo; ritorna la proposta pubblica.

    Include il giro di budget del turno (scopo ``front_door``), così i test che
    leggono i budget del lavoro vedono lo stesso stato della sequenza reale.
    """
    from homun.application.work import budgets as work_budgets
    from homun.application.work.intake import commit_front_door_proposal, confirm as intake_confirm
    from homun.domain.models import BudgetCounters
    from homun.models.intake import IntakeBrief
    reservation = work_budgets.reserve(ctx, actor, work_id, BudgetCounters(attempts=1),
                                       purpose='front_door')
    # Il giro di setup non riporta token: resta «sconosciuto», così i contatori
    # «spesi» dei test restano quelli della chiamata che misurano.
    work_budgets.reconcile_unknown(ctx, actor, work_id, reservation)
    conversation_id = ctx.repository.load().works[work_id].primary_conversation_id
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            ctx.service.store = store
            ctx.service.for_store(store).apply(actor, f'{command_id}:message',
                                               'conversation.post_message',
                                               {'conversation_id': conversation_id, 'text': text})
            proposal = commit_front_door_proposal(
                ctx, actor, command_id=command_id, conversation_id=conversation_id,
                work_id=work_id, brief=IntakeBrief.model_validate(brief), text=text)
    ctx.service.store = ctx.repository.load()
    if confirm:
        assert proposal['status'] == 'pending_confirmation', proposal
        proposal = intake_confirm(ctx, actor, work_id, proposal['id'], {
            'command_id': f'{command_id}:confirm', 'digest': proposal['digest'],
            'expected_version': proposal['expected_version'], 'create_agent': create_agent})
    return proposal
