"""Tests for extended Hermes channel and messaging adapters (H33)."""
import pytest

from homun.application.channel_contracts import ChannelAdapter
from homun.application.channel_adapters_protocols import (
    BlueBubblesAdapter,
    EmailAdapter,
    IrcAdapter,
    LineAdapter,
    SignalAdapter,
    SimplexAdapter,
    SmsAdapter,
)
from homun.application.channel_adapters_catalog import (
    DingTalkAdapter,
    FeishuChannelAdapter,
    GoogleChatAdapter,
    MattermostAdapter,
    QqBotAdapter,
    TeamsAdapter,
    WeComAdapter,
    WeixinAdapter,
)
from homun.application.channel_adapters_extended import (
    A2AAdapter,
    BuzzAdapter,
    HomeAssistantAdapter,
    MSGraphWebhookAdapter,
    OpenWebUIAdapter,
    PhotonAdapter,
    RaftAdapter,
)
from homun.application.channel_adapters_relay import (
    TeamsMeetingsAdapter,
    WeComCallbackAdapter,
    WhatsAppCloudAdapter,
    YuanbaoAdapter,
)


def test_signal_send_without_rest_url_unavailable():
    out = SignalAdapter().send("+15551234567", "hi")
    assert out["delivered"] is False
    assert out.get("code") == "backend_unavailable"


def test_signal_send_posts_when_rest_configured(monkeypatch):
    calls = []

    class _Resp:
        status_code = 201
        content = b"{}"

    class _Client:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, headers=None):
            calls.append({"url": url, "json": json})
            return _Resp()

    monkeypatch.setattr("homun.application.channel_adapters_protocols.httpx.Client", _Client)
    out = SignalAdapter(config={"rest_url": "http://127.0.0.1:8080", "number": "+100"}).send(
        "+1555", "ping"
    )
    assert out["delivered"] is True
    assert calls[0]["url"].endswith("/v2/send")
    assert calls[0]["json"]["recipients"] == ["+1555"]


def test_irc_send_without_host_unavailable():
    out = IrcAdapter().send("#homun", "hi")
    assert out["delivered"] is False
    assert out.get("code") == "backend_unavailable"


def test_irc_send_uses_socket_when_configured(monkeypatch):
    sent = []

    class FakeSock:
        def settimeout(self, t):
            return None

        def sendall(self, data):
            sent.append(data.decode())

        def recv(self, n):
            raise __import__("socket").timeout()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(
        "homun.application.channel_adapters_protocols.socket.create_connection",
        lambda *a, **k: FakeSock(),
    )
    out = IrcAdapter(config={"host": "irc.example", "nick": "bot"}).send("#homun", "hello")
    assert out["delivered"] is True
    assert any("PRIVMSG #homun :hello" in s for s in sent)
    assert any(s.startswith("NICK bot") for s in sent)


def test_feishu_mattermost_google_chat_require_credentials():
    assert FeishuChannelAdapter().send("oc_chat", "hi")["delivered"] is False
    assert MattermostAdapter().send("chan", "hi")["delivered"] is False
    assert GoogleChatAdapter().send("spaces/abc", "hi")["delivered"] is False
    assert DingTalkAdapter().send("not-a-url", "hi")["delivered"] is False
    assert WeComAdapter().send("not-a-url", "hi")["delivered"] is False


def test_mattermost_and_webhook_adapters_post(monkeypatch):
    posted = []

    class FakeResp:
        status_code = 200
        content = b'{"id":"p1"}'

        def json(self):
            return {"id": "p1"}

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, headers=None):
            posted.append((url, json, headers))
            return FakeResp()

    monkeypatch.setattr("homun.application.channel_adapters_catalog.httpx.Client", FakeClient)
    adapter = MattermostAdapter(config={"base_url": "https://mm.example", "token": "tok"})
    res = adapter.send("c1", "hello mm", reply_to_id="root_9")
    assert res["delivered"] is True
    assert posted[0][0] == "https://mm.example/api/v4/posts"
    assert posted[0][1]["channel_id"] == "c1"
    assert posted[0][1]["root_id"] == "root_9"


def test_line_teams_sms_require_credentials():
    assert LineAdapter().send("u1", "hi")["delivered"] is False
    assert TeamsAdapter().send("c1", "hi")["delivered"] is False
    assert SmsAdapter().send("+1555", "hi")["delivered"] is False


def test_line_teams_sms_http_send(monkeypatch):
    calls = []

    class FakeResp:
        status_code = 200
        content = b"{}"

        def json(self):
            return {"sid": "SM123"}

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, headers=None, data=None, auth=None):
            calls.append((url, json, data))
            return FakeResp()

    monkeypatch.setattr("homun.application.channel_adapters_catalog.httpx.Client", FakeClient)
    monkeypatch.setattr("homun.application.channel_adapters_protocols.httpx.Client", FakeClient)

    line = LineAdapter(config={"token": "t"})
    assert line.send("u1", "hello line")["delivered"] is True

    teams = TeamsAdapter(config={"webhook_url": "https://teams.example/hook"})
    assert teams.send("c1", "hello teams")["delivered"] is True

    sms = SmsAdapter(config={"account_sid": "AC1", "token": "tok", "from_number": "+123"})
    assert sms.send("+456", "hello sms")["delivered"] is True


def test_bluebubbles_requires_credentials():
    assert BlueBubblesAdapter().send("chat_guid", "hi")["delivered"] is False


def test_bluebubbles_http_send(monkeypatch):
    class FakeResp:
        status_code = 200
        content = b"{}"

        def json(self):
            return {}

    class FakeClient:
        last = None

        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, params=None):
            FakeClient.last = (url, json, params)
            return FakeResp()

    monkeypatch.setattr("homun.application.channel_adapters_protocols.httpx.Client", FakeClient)
    adapter = BlueBubblesAdapter(config={"base_url": "http://127.0.0.1:1234", "password": "pass"})
    out = adapter.send("chat-guid-1", "hi imessage")
    assert out["delivered"] is True
    assert FakeClient.last[0].endswith("/api/v1/message/text")


def test_weixin_qqbot_require_credentials():
    assert WeixinAdapter().send("openid", "hi")["delivered"] is False
    assert QqBotAdapter().send("channel", "hi")["delivered"] is False


def test_weixin_qqbot_http_send(monkeypatch):
    class FakeResp:
        status_code = 200
        content = b'{"errcode":0}'

        def json(self):
            return {"errcode": 0}

    class FakeClient:
        last = None

        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, headers=None):
            FakeClient.last = (url, json, headers)
            return FakeResp()

    monkeypatch.setattr("homun.application.channel_adapters_catalog.httpx.Client", FakeClient)
    assert WeixinAdapter(config={"token": "t"}).send("o1", "hi")["delivered"] is True
    assert "api.weixin.qq.com" in FakeClient.last[0]
    assert QqBotAdapter(config={"token": "t", "app_id": "a"}).send("c1", "hi")["delivered"] is True
    assert "api.sgroup.qq.com" in FakeClient.last[0]


def test_simplex_photon_require_config():
    assert SimplexAdapter().send("contact", "hi")["delivered"] is False
    assert PhotonAdapter().send("room", "hi")["delivered"] is False


def test_simplex_photon_http_send(monkeypatch):
    class FakeResp:
        status_code = 200
        content = b"{}"

    class FakeClient:
        last = None

        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, headers=None):
            FakeClient.last = (url, json, headers)
            return FakeResp()

    monkeypatch.setattr("homun.application.channel_adapters_protocols.httpx.Client", FakeClient)
    monkeypatch.setattr("homun.application.channel_adapters_extended.httpx.Client", FakeClient)
    assert SimplexAdapter(config={"base_url": "http://127.0.0.1:5225"}).send("c", "hi")["delivered"] is True
    assert FakeClient.last[0].endswith("/send")
    assert PhotonAdapter(config={"webhook_url": "https://photon.example/hook"}).send("r", "hi")["delivered"] is True


def test_a2a_requires_url():
    assert A2AAdapter().send("agent", "hi")["delivered"] is False


def test_a2a_http_send(monkeypatch):
    class FakeResp:
        status_code = 200
        content = b"{}"

    class FakeClient:
        last = None

        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, headers=None):
            FakeClient.last = url
            return FakeResp()

    monkeypatch.setattr("homun.application.channel_adapters_extended.httpx.Client", FakeClient)
    out = A2AAdapter(config={"base_url": "https://a2a.example"}).send("ignored", "hi")
    assert out["delivered"] is True
    assert FakeClient.last.endswith("/message:send")


def test_buzz_raft_require_config():
    assert BuzzAdapter().send("ch", "hi")["delivered"] is False
    assert RaftAdapter().send("topic", "hi")["delivered"] is False


def test_buzz_raft_http_send(monkeypatch):
    class FakeResp:
        status_code = 200
        content = b"{}"

    class FakeClient:
        last = None

        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, headers=None):
            FakeClient.last = url
            return FakeResp()

    monkeypatch.setattr("homun.application.channel_adapters_extended.httpx.Client", FakeClient)
    assert BuzzAdapter(config={"webhook_url": "https://buzz.example/h"}).send("c", "hi")["delivered"] is True
    assert RaftAdapter(config={"base_url": "https://raft.example"}).send("t1", "hi")["delivered"] is True
    assert "/topics/t1/publish" in FakeClient.last


def test_homeassistant_msgraph_openwebui_require_config():
    assert HomeAssistantAdapter().send("notify", "hi")["delivered"] is False
    assert MSGraphWebhookAdapter().send("chat_id", "hi")["delivered"] is False
    assert OpenWebUIAdapter().send("c_id", "hi")["delivered"] is False


def test_homeassistant_msgraph_openwebui_http_send(monkeypatch):
    calls = []

    class FakeResp:
        status_code = 200
        content = b"{}"

        def json(self):
            return {}

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, headers=None):
            calls.append((url, json, headers))
            return FakeResp()

    monkeypatch.setattr("homun.application.channel_adapters_extended.httpx.Client", FakeClient)

    hass = HomeAssistantAdapter(config={"base_url": "http://hass.local:8123", "token": "tok"})
    assert hass.send("notify.telegram", "test hass")["delivered"] is True
    assert "api/services/notify" in calls[-1][0]

    msgraph = MSGraphWebhookAdapter(config={"token": "azure_tok"})
    assert msgraph.send("chat123", "test msgraph")["delivered"] is True
    assert "graph.microsoft.com" in calls[-1][0]

    openwebui = OpenWebUIAdapter(config={"base_url": "http://127.0.0.1:3000", "token": "owui_tok"})
    assert openwebui.send("chat456", "test owui")["delivered"] is True
    assert "api/v1/chats/chat456/messages" in calls[-1][0]


def test_relay_adapters_require_config():
    assert TeamsMeetingsAdapter().send("meet1", "hi")["delivered"] is False
    assert WeComCallbackAdapter().send("user1", "hi")["delivered"] is False
    assert WhatsAppCloudAdapter().send("+123", "hi")["delivered"] is False
    assert YuanbaoAdapter().send("bot1", "hi")["delivered"] is False


def test_relay_adapters_http_send(monkeypatch):
    calls = []

    class FakeResp:
        status_code = 200
        content = b"{}"

        def json(self):
            return {}

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, headers=None):
            calls.append((url, json, headers))
            return FakeResp()

    monkeypatch.setattr("homun.application.channel_adapters_relay.httpx.Client", FakeClient)

    teams_meet = TeamsMeetingsAdapter(config={"webhook_url": "https://teams.example/meet"})
    assert teams_meet.send("m1", "meeting starting")["delivered"] is True

    wecom_cb = WeComCallbackAdapter(config={"webhook_url": "https://wecom.example/cb"})
    assert wecom_cb.send("u1", "callback msg")["delivered"] is True

    wa_cloud = WhatsAppCloudAdapter(config={"token": "wa_tok", "phone_number_id": "12345"})
    assert wa_cloud.send("+1555000", "wa cloud msg")["delivered"] is True
    assert "graph.facebook.com" in calls[-1][0]

    yuanbao = YuanbaoAdapter(config={"token": "yb_tok", "base_url": "https://yuanbao.example/api"})
    assert yuanbao.send("ch1", "yuanbao msg")["delivered"] is True
    assert "yuanbao.example" in calls[-1][0]
