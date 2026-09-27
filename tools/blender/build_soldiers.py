"""Build the rigged, animated soldiers (both factions) + static far-LOD poses.

    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \\
        --python tools/blender/build_soldiers.py

Outputs public/models/soldier_rig_{nato,opfor}.glb, soldier_{stand,kneel,prone,dead}_{side}.glb
and soldier_rig.json (clip list, durations, locomotion speeds).
"""
import importlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import mc_lib  # noqa: E402
import mc_soldier_rig  # noqa: E402

importlib.reload(mc_lib)
importlib.reload(mc_soldier_rig)

OUT = os.path.abspath(os.path.join(HERE, '..', '..', 'public', 'models'))
info = mc_soldier_rig.build_all(OUT)
print('[soldier] clips:', ', '.join(info['clips']))
