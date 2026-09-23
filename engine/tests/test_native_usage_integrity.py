"""Provider metadata must never reduce spent tokens or fabricate rounded usage."""
import pytest
from homun.models.native_transport import usage_from_response


@pytest.mark.parametrize('value',[-1,1.5,float('nan'),float('inf'),True,'12'])
@pytest.mark.parametrize('ollama',[False,True])
def test_invalid_token_counter_is_unknown_while_valid_counter_survives(value,ollama):
    response=({'prompt_eval_count':value,'eval_count':12} if ollama else
              {'usage':{'prompt_tokens':value,'completion_tokens':12}})
    usage=usage_from_response(response,provider_id='test',model_id='test',ollama=ollama)
    assert usage.input_tokens is None
    assert usage.output_tokens==12
    assert usage.status=='unknown'
