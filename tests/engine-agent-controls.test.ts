import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { componentRenderer } from './helpers/render-component.ts';

test('native running controls expose pause, cancellation and clearly distinct correction modes', async () => {
  const path = 'apps/web/src/components/builder/EngineAgentControls.tsx';
  assert.ok(existsSync(path), 'native run controls panel exists');
  const renderer = await componentRenderer(path, 'EngineAgentControls');
  try {
    const props = {workId:'w', run:{id:'r',status:'running',tool_version:'adaptive-materials-native-v2'}, onUpdated:() => {}};
    const html = renderer.render(props);
    assert.match(html, />Pausa</);
    assert.match(html, />Interrompi</);
    assert.match(html, /prossimo passaggio/);
    assert.match(html, /Rivedi il piano/);
    assert.match(html, /scarta le azioni ancora da eseguire/);
    const paused = renderer.render({...props,run:{...props.run,status:'paused'}});
    assert.match(paused, />Riprendi</);
    assert.doesNotMatch(paused, />Pausa</);
    const waiting = renderer.render({...props,run:{...props.run,status:'waiting_input'}});
    assert.match(waiting, />Interrompi</);
    assert.doesNotMatch(waiting, />Pausa<|>Invia correzione<|>Rivedi il piano<|<textarea/);
    for (const run of [{...props.run,status:'completed'}, {...props.run,tool_version:'adaptive-materials-v1'}]) {
      assert.equal(renderer.render({...props,run}), '');
    }
  } finally { await renderer.close(); }
});
