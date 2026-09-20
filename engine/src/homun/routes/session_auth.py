"""Ephemeral local desktop session; tokens never enter workspace persistence."""
import secrets
import re
from starlette.responses import JSONResponse


class SessionAuthMiddleware:
    def __init__(self, app, *, token: str, origins: list[str], actor_id: str):
        if len(token) < 32:
            raise ValueError('Session token must contain at least 32 characters')
        if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', actor_id or ''):
            raise ValueError('Invalid bound session actor')
        self.actor_id = actor_id
        self.app, self.token, self.origins = app, token, frozenset(origins)

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        headers = {key.lower(): value for key, value in scope['headers']}
        origin = headers.get(b'origin', b'').decode('latin1')
        if origin and origin not in self.origins:
            response = JSONResponse(status_code=403, content={'detail': {'code': 'origin_denied', 'message': 'Origin is not allowed'}})
        elif scope['method'] == 'OPTIONS' and origin:
            # CORS middleware answers preflight; no handler or data is reached.
            return await self.app(scope, receive, send)
        elif not secrets.compare_digest(headers.get(b'authorization', b''), ('Bearer '+self.token).encode()):
            response = JSONResponse(status_code=401, content={'detail': {'code': 'session_required', 'message': 'A valid local session is required'}})
        else:
            actor_headers = [value for key, value in scope['headers'] if key.lower() == b'x-homun-actor-id']
            if actor_headers and actor_headers != [self.actor_id.encode('ascii')]:
                response = JSONResponse(status_code=403, content={'detail': {
                    'code': 'session_actor_mismatch', 'message': 'Actor does not match the authenticated local session'}})
            else:
                # Replace cosmetic names too; identity always originates in the launcher.
                trusted = [(key, value) for key, value in scope['headers']
                           if key.lower() not in {b'x-homun-actor-id', b'x-homun-actor-name'}]
                trusted.extend([(b'x-homun-actor-id', self.actor_id.encode('ascii')),
                                (b'x-homun-actor-name', self.actor_id.encode('ascii'))])
                scope = {**scope, 'headers': trusted}
                return await self.app(scope, receive, send)
        await response(scope, receive, send)
