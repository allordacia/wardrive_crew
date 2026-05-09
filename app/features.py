"""Runtime feature toggles.

Each loop that's gated on an env var (rtl_433, sdr/rtl_power, bt,
wifi STA tracker, etc.) reads its enabled state through this module.
The state is a tristate per feature:

    "on"      — operator forced ON via the CONFIG modal
    "off"     — operator forced OFF via the CONFIG modal
    "default" — fall back to the env var (legacy behaviour)

The override is persisted in the SQLite ``settings`` table under the
key ``feature.<name>``. Empty / missing means "default".

This lets the operator flip rtl_433 on after boot, kill the BLE
scanner mid-session, etc., without restarting the container.
"""

from __future__ import annotations

import os
from typing import Iterable

from .state import STATE


# Registry of features the CONFIG modal exposes. Each entry:
#   (name, description, env_var, env_default_truthy)
# env_default_truthy is what "default" evaluates to when the env var
# is unset — typically False since the env defaults are off.
FEATURES = [
    ("rtl433",  "rtl_433 consumer-device decoder",        "WARDRIVE_RTL433_ENABLED",  False),
    ("sdr",     "rtl_power band sweep (mutex w/ rtl_433)", "WARDRIVE_SDR_ENABLED",     False),
    ("bt",      "BLE advertisement scanner",              "WARDRIVE_BT_ENABLED",      False),
    ("clients", "Wifi STA / probe-request sniffer",       "WARDRIVE_CLIENTS_ENABLED", True),
]

FEATURE_NAMES = {f[0] for f in FEATURES}
_ENV_BY_NAME = {f[0]: (f[2], f[3]) for f in FEATURES}


def _key(name: str) -> str:
    return f"feature.{name}"


def get_override(name: str) -> str:
    """Return 'on' / 'off' / '' (== default) for the named feature."""
    if name not in FEATURE_NAMES:
        return ""
    raw = (STATE.get_setting(_key(name)) or "").strip().lower()
    return raw if raw in ("on", "off") else ""


def set_override(name: str, value: str) -> str:
    """Persist a new override. ``value`` may be 'on', 'off', or '' (==
    'default'). Anything else is treated as default."""
    if name not in FEATURE_NAMES:
        raise ValueError(f"unknown feature {name!r}")
    norm = (value or "").strip().lower()
    if norm not in ("on", "off"):
        norm = ""  # default
    STATE.set_setting(_key(name), norm)
    return norm


def env_default(name: str) -> bool:
    env_var, fallback = _ENV_BY_NAME[name]
    return os.environ.get(env_var, "1" if fallback else "0") == "1"


def is_enabled(name: str) -> bool:
    """Resolve the effective on/off for the named feature.

    rtl_433 and sdr (rtl_power) share the SDR dongle and can't run
    simultaneously. When both resolve to 'on', rtl_433 wins.
    """
    if name not in FEATURE_NAMES:
        return False
    override = get_override(name)
    if override == "on":
        eff = True
    elif override == "off":
        eff = False
    else:
        eff = env_default(name)
    if name == "sdr" and eff:
        # Mutex: if rtl_433 is also on, sdr loses.
        if get_override("rtl433") == "on" or (
            get_override("rtl433") == "" and env_default("rtl433")
        ):
            return False
    return eff


def all_states() -> list[dict]:
    """Snapshot for /ws and the CONFIG modal: every feature with its
    override, env default, and effective state."""
    out = []
    for name, desc, env_var, _fallback in FEATURES:
        out.append({
            "name": name,
            "description": desc,
            "env_var": env_var,
            "override": get_override(name) or "default",
            "env_default": env_default(name),
            "enabled": is_enabled(name),
        })
    return out


def feature_names() -> Iterable[str]:
    return list(FEATURE_NAMES)
