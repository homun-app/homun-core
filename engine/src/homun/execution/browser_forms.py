"""Fill and press controls on one owned browser page.

Refs come from the page accessibility tree. Hermes browser tools (MIT) use the
same navigate, snapshot, type, click and press sequence. Homun does not copy
the Hermes supervisor, and it does not use the person's browser profile.
"""
from homun.execution.owned_browser import TEXT_LIMIT, OwnedBrowser
from homun.execution.web_pages import PageRefusal, _classify

_INTERACTIVE = frozenset({
    "textbox", "searchbox", "combobox", "button", "link", "checkbox", "radio", "switch", "tab",
})
_FIELDS = frozenset({"textbox", "searchbox", "combobox"})
_NAMED_KEYS = {
    "Enter": 13, "Tab": 9, "Escape": 27, "Backspace": 8,
    "ArrowUp": 38, "ArrowDown": 40, "ArrowLeft": 37, "ArrowRight": 39,
}


def _key_code(key: str) -> int | None:
    if key in _NAMED_KEYS:
        return _NAMED_KEYS[key]
    if len(key) == 1 and key.isascii() and key.isalnum():
        return ord(key.upper())
    return None


def _enable(browser: OwnedBrowser):
    page = browser._page_socket()
    page.call("Page.enable")
    page.call("DOM.enable")
    page.call("DOM.getDocument")
    page.call("Accessibility.enable")
    return page


def _collect_child_frames(frame_node: dict) -> list[tuple[str, str]]:
    results: list[tuple[str, str]] = []
    for child in frame_node.get("childFrames") or []:
        if not isinstance(child, dict):
            continue
        frame = child.get("frame") or {}
        fid = frame.get("id")
        furl = str(frame.get("url") or "")
        if fid:
            results.append((fid, furl))
        results.extend(_collect_child_frames(child))
    return results


def snapshot(browser: OwnedBrowser) -> dict:
    """Replace the ref map with the current interactive controls."""
    settled = browser.wait_document(dismiss_dialogs=True)
    if "error_code" in settled:
        return settled
    page = _enable(browser)
    tree = page.call("Accessibility.getFullAXTree")
    nodes = (tree.get("result") or {}).get("nodes") or []
    refs: dict[str, dict] = {}
    lines: list[str] = []
    for node in nodes:
        if node.get("ignored"):
            continue
        role = str((node.get("role") or {}).get("value") or "")
        backend = node.get("backendDOMNodeId")
        if role not in _INTERACTIVE or not isinstance(backend, int):
            continue
        ref = f"@e{len(refs) + 1}"
        if len(refs) >= 80:
            break
        name = str((node.get("name") or {}).get("value") or "")[:120]
        refs[ref] = {"backend": backend, "role": role}
        lines.append(f"{ref} {role} {name}".rstrip())
    if getattr(browser, "include_frames", False) and len(refs) < 80:
        try:
            tree_frames = page.call("Page.getFrameTree")
            root_frame = (tree_frames.get("result") or {}).get("frameTree") or {}
            for frame_id, frame_url in _collect_child_frames(root_frame):
                if len(refs) >= 80:
                    break
                if frame_url.startswith("http://") or frame_url.startswith("https://"):
                    try:
                        _classify(frame_url)
                    except PageRefusal:
                        continue
                try:
                    ax = page.call("Accessibility.getFullAXTree", {"frameId": frame_id})
                    for node in (ax.get("result") or {}).get("nodes") or []:
                        if node.get("ignored"):
                            continue
                        role = str((node.get("role") or {}).get("value") or "")
                        backend = node.get("backendDOMNodeId")
                        if role not in _INTERACTIVE or not isinstance(backend, int):
                            continue
                        ref = f"@e{len(refs) + 1}"
                        if len(refs) >= 80:
                            break
                        name = str((node.get("name") or {}).get("value") or "")[:120]
                        refs[ref] = {"backend": backend, "role": role}
                        lines.append(f"{ref} {role} {name}".rstrip())
                except Exception:
                    continue
        except Exception:
            pass
    browser.refs = refs
    text = "\n".join(lines)
    body = {"url": settled["url"], "snapshot": text[:TEXT_LIMIT], "truncated": len(text) > TEXT_LIMIT}
    if settled.get("dialogs"):
        body["dialogs"] = settled["dialogs"]
    return body


def open_page(browser: OwnedBrowser, url: str) -> dict:
    opened = browser.read(url, dismiss_dialogs=True)
    if "error_code" in opened:
        return opened
    listed = snapshot(browser)
    if "error_code" in listed:
        return listed
    opened["snapshot"] = listed["snapshot"]
    return opened


def _field(browser: OwnedBrowser, ref: str) -> dict | None:
    item = browser.refs.get(ref)
    if not isinstance(item, dict):
        return None
    return item


def fill(browser: OwnedBrowser, ref: str, text: str) -> dict:
    """Clear one text field and set its value. The typed text is not echoed."""
    settled = browser.wait_document(dismiss_dialogs=True)
    if "error_code" in settled:
        return settled
    item = _field(browser, ref)
    if item is None:
        return {"error_code": "browser_ref_unknown", "message": "That ref is not in the latest snapshot"}
    if item["role"] not in _FIELDS:
        return {"error_code": "browser_target_missing", "message": "That ref is not a text field"}
    page = _enable(browser)
    resolved = page.call("DOM.resolveNode", {"backendNodeId": item["backend"]})
    object_id = ((resolved.get("result") or {}).get("object") or {}).get("objectId")
    if not object_id:
        return {"error_code": "browser_target_missing", "message": "The field is no longer on the page"}
    applied = page.call("Runtime.callFunctionOn", {
        "objectId": object_id,
        "functionDeclaration": (
            "function(value){ if(!('value' in this)) return false; this.focus(); this.value=''; "
            "this.value=String(value); this.dispatchEvent(new Event('input',{bubbles:true})); "
            "this.dispatchEvent(new Event('change',{bubbles:true})); return this.value===String(value); }"
        ),
        "arguments": [{"value": text}],
        "returnByValue": True,
    })
    if ((applied.get("result") or {}).get("result") or {}).get("value") is not True:
        return {"error_code": "browser_target_missing", "message": "The field did not accept the text"}
    return {"url": settled["url"], "ref": ref, "typed": True}


def click(browser: OwnedBrowser, ref: str) -> dict:
    settled = browser.wait_document(dismiss_dialogs=True)
    if "error_code" in settled:
        return settled
    item = _field(browser, ref)
    if item is None:
        return {"error_code": "browser_ref_unknown", "message": "That ref is not in the latest snapshot"}
    page = _enable(browser)
    box = page.call("DOM.getBoxModel", {"backendNodeId": item["backend"]})
    quad = ((box.get("result") or {}).get("model") or {}).get("content") or []
    if len(quad) < 8:
        return {"error_code": "browser_target_missing", "message": "The control is not visible"}
    point = {"x": sum(quad[0::2]) / 4, "y": sum(quad[1::2]) / 4, "button": "left", "clickCount": 1}
    page.call("Input.dispatchMouseEvent", {"type": "mousePressed", **point})
    page.call("Input.dispatchMouseEvent", {"type": "mouseReleased", **point})
    browser.refs = {}
    listed = snapshot(browser)
    if "error_code" not in listed:
        listed["clicked"] = ref
    return listed


def press(browser: OwnedBrowser, key: str) -> dict:
    code = _key_code(key)
    if code is None:
        return {"error_code": "browser_key_refused", "message": "That key is not available"}
    settled = browser.wait_document(dismiss_dialogs=True)
    if "error_code" in settled:
        return settled
    page = browser._page_socket()
    text = key if len(key) == 1 else ""
    page.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": key, "windowsVirtualKeyCode": code, "text": text})
    page.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": key, "windowsVirtualKeyCode": code})
    browser.refs = {}
    listed = snapshot(browser)
    if "error_code" not in listed:
        listed["pressed"] = key
    return listed
