"""Keep the person's wording available after the model summarizes an agreement."""


def request_history(store, work_id):
    records = sorted((r for r in store.commands.values()
                      if r.type == 'intake.propose' and r.result.get('work_id') == work_id
                      and r.result.get('status') != 'failed'), key=lambda r: r.created_at)
    return '\n\n'.join(r.result.get('_submitted_text', '') for r in records)[-12000:]
