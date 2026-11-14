#!/usr/bin/env python3
"""Direct idalib analysis (no MCP, no GUI).

Invoked by server.py with the IDA venv interpreter. The binary is read-only;
the script emits a bounded JSON summary and closes the database.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit("usage: ida_runner.py <binary> <output.json>")
    binary = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    import idapro  # type: ignore  # must be imported before IDA modules
    import ida_auto, ida_entry, ida_funcs, ida_hexrays, ida_loader, ida_name, idautils, idc  # type: ignore

    result: dict[str, object] = {"binary": str(binary), "format": "unknown", "functions": [], "exports": [], "strings": [], "pseudocode": []}
    rc = idapro.open_database(str(binary), True)
    if rc != 0:
        raise RuntimeError(f"idalib open_database failed rc={rc}")
    try:
        ida_auto.auto_wait()
        try:
            result["format"] = str(ida_loader.get_file_type_name() or "unknown")
        except Exception:
            result["format"] = "unknown"
        try:
            ida_hexrays.init_hexrays_plugin()
        except Exception:
            pass
        functions = []
        for index in range(min(ida_funcs.get_func_qty(), 5_000)):
            ea = ida_funcs.get_func_ea_by_num(index)
            name = ida_funcs.get_func_name(ea) or ""
            functions.append({"ea": hex(ea), "name": name[:300]})
            if len(functions) >= 2_000:
                break
        result["functions"] = functions
        exports = []
        for index in range(min(ida_entry.get_entry_qty(), 2_000)):
            ordinal = ida_entry.get_entry_ordinal(index)
            ea = ida_entry.get_entry(ordinal)
            name = ida_entry.get_entry_name(ordinal) or ""
            if name:
                exports.append({"ea": hex(ea), "name": name[:300]})
        result["exports"] = exports[:500]
        strings = []
        for item in idautils.Strings():
            # IDA 9.5 yields StringItem objects; older builds yielded (ea, text).
            try:
                text = item.synthetic_string if item.is_synthetic_string() else idc.get_strlit_contents(item.ea, item.length, item.strtype)
                ea = item.ea
            except AttributeError:
                ea, text = item  # type: ignore[misc]
            if isinstance(text, (bytes, bytearray)):
                text = text.decode("utf-8", "replace")
            if text:
                strings.append({"ea": hex(ea), "text": str(text)[:500]})
                if len(strings) >= 300:
                    break
        result["strings"] = strings
        # Decompile a small number of named/entry functions, bounded.
        targets = []
        for item in exports[:20]:
            try:
                targets.append(int(item["ea"], 16))
            except ValueError:
                pass
        for ea in targets[:20]:
            try:
                code = ida_hexrays.decompile(ea)
                if code:
                    result["pseudocode"].append({"ea": hex(ea), "code": str(code)[:12_000]})
            except Exception:
                continue
    finally:
        idapro.close_database(False)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
