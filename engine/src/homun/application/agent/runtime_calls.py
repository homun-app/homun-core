"""Revalidate the pinned request immediately before each model transport call."""
from homun.application.runtime_selection import kwargs as runtime_kwargs


def complete(ctx, run, messages, *, connection_id=None, model_id=None):
    return ctx.models.complete(messages, **runtime_kwargs(ctx.models, run, connection_id=connection_id, model_id=model_id))


def complete_summary(ctx, run, messages, *, connection_id=None, model_id=None, **options):
    return ctx.models.complete_summary(messages,
        **runtime_kwargs(ctx.models, run, connection_id=connection_id, model_id=model_id), **options)
