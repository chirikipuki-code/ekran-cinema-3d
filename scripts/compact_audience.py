"""Keep three seated figures and only their referenced GLB data."""
from __future__ import annotations
import copy
import json
import struct
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "web/models/audience-row.glb"
OUTPUT = ROOT / "web/models/audience-near.glb"
NAMES = ("Avery", "Riley", "Nora")
raw = SOURCE.read_bytes()
assert raw[:4] == b"glTF" and struct.unpack_from("<I", raw, 4)[0] == 2
json_len, json_type = struct.unpack_from("<I4s", raw, 12)
assert json_type == b"JSON"
old = json.loads(raw[20:20 + json_len])
bin_header = 20 + json_len
bin_len, bin_type = struct.unpack_from("<I4s", raw, bin_header)
assert bin_type == b"BIN\x00"
binary = raw[bin_header + 8:bin_header + 8 + bin_len]

roots = [i for i, node in enumerate(old["nodes"]) if any(node.get("name", "").startswith(name + " | authored figure") for name in NAMES)]
assert len(roots) == len(NAMES)
needed_nodes = set()
def walk(index):
    if index in needed_nodes:
        return
    needed_nodes.add(index)
    for child in old["nodes"][index].get("children", []):
        walk(child)
for root in roots:
    walk(root)

def select(name, indices):
    order = sorted(indices)
    return [copy.deepcopy(old[name][i]) for i in order], {value: pos for pos, value in enumerate(order)}

nodes, node_map = select("nodes", needed_nodes)
for node in nodes:
    if "children" in node:
        node["children"] = [node_map[i] for i in node["children"]]
meshes, mesh_map = select("meshes", {node["mesh"] for node in nodes if "mesh" in node})
for node in nodes:
    if "mesh" in node:
        node["mesh"] = mesh_map[node["mesh"]]
materials, material_map = select("materials", {prim["material"] for mesh in meshes for prim in mesh["primitives"]})
accessors, accessor_map = select("accessors", {index for mesh in meshes for prim in mesh["primitives"] for index in [prim["indices"], *prim["attributes"].values()]})
for mesh in meshes:
    for prim in mesh["primitives"]:
        prim["material"] = material_map[prim["material"]]
        prim["indices"] = accessor_map[prim["indices"]]
        prim["attributes"] = {key: accessor_map[index] for key, index in prim["attributes"].items()}

used_textures = set()
def scan_textures(value, key=""):
    if isinstance(value, dict):
        if key.endswith("Texture") and "index" in value:
            used_textures.add(value["index"])
        for child_key, child_value in value.items():
            scan_textures(child_value, child_key)
    elif isinstance(value, list):
        for child in value:
            scan_textures(child)
for mat in materials:
    scan_textures(mat)
textures, texture_map = select("textures", used_textures)
def remap_textures(value, key=""):
    if isinstance(value, dict):
        if key.endswith("Texture") and "index" in value:
            value["index"] = texture_map[value["index"]]
        for child_key, child_value in value.items():
            remap_textures(child_value, child_key)
    elif isinstance(value, list):
        for child in value:
            remap_textures(child)
for mat in materials:
    remap_textures(mat)
images, image_map = select("images", {texture["source"] for texture in textures})
for texture in textures:
    texture["source"] = image_map[texture["source"]]

views_needed = {accessor["bufferView"] for accessor in accessors} | {image["bufferView"] for image in images}
views, view_map = select("bufferViews", views_needed)
image_bytes = {}
with tempfile.TemporaryDirectory() as temporary:
    for index, image in enumerate(images):
        old_view_index = image["bufferView"]
        source_view = old["bufferViews"][old_view_index]
        offset = source_view.get("byteOffset", 0)
        content = binary[offset:offset + source_view["byteLength"]]
        extension = ".jpg" if image["mimeType"] == "image/jpeg" else ".png"
        image_path = Path(temporary) / f"image-{index}{extension}"
        image_path.write_bytes(content)
        result = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(image_path)], capture_output=True, text=True, check=True)
        dimensions = [int(line.split(":", 1)[1]) for line in result.stdout.splitlines() if "pixelWidth:" in line or "pixelHeight:" in line]
        if dimensions and max(dimensions) > 1024:
            resized_path = Path(temporary) / f"resized-{index}{extension}"
            command = ["sips", "-Z", "1024"]
            if extension == ".jpg":
                command += ["-s", "formatOptions", "75"]
            subprocess.run(command + [str(image_path), "--out", str(resized_path)], capture_output=True, check=True)
            image_bytes[old_view_index] = resized_path.read_bytes()
packed = bytearray()
for old_index in sorted(views_needed):
    view = views[view_map[old_index]]
    offset = old["bufferViews"][old_index].get("byteOffset", 0)
    length = view["byteLength"]
    content = image_bytes.get(old_index, binary[offset:offset + length])
    packed.extend(b"\x00" * ((-len(packed)) % 4))
    view["byteOffset"] = len(packed)
    view["byteLength"] = len(content)
    packed.extend(content)
packed.extend(b"\x00" * ((-len(packed)) % 4))
for accessor in accessors:
    accessor["bufferView"] = view_map[accessor["bufferView"]]
for image in images:
    image["bufferView"] = view_map[image["bufferView"]]

result = {
    "asset": old["asset"],
    "scene": 0,
    "scenes": [{"nodes": [node_map[root] for root in roots]}],
    "nodes": nodes,
    "meshes": meshes,
    "materials": materials,
    "textures": textures,
    "images": images,
    "accessors": accessors,
    "bufferViews": views,
    "samplers": old["samplers"],
    "buffers": [{"byteLength": len(packed)}],
}
for key in ("extensionsUsed", "extensionsRequired"):
    if key in old:
        result[key] = old[key]
encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
encoded += b" " * ((-len(encoded)) % 4)
total = 12 + 8 + len(encoded) + 8 + len(packed)
OUTPUT.write_bytes(b"glTF" + struct.pack("<II", 2, total) + struct.pack("<I4s", len(encoded), b"JSON") + encoded + struct.pack("<I4s", len(packed), b"BIN\x00") + packed)
print(f"{SOURCE.stat().st_size / 1e6:.1f} MB → {OUTPUT.stat().st_size / 1e6:.1f} MB; {len(nodes)} nodes, {len(images)} images")
