# 把 Your Mom 的 vivian UnityFS bundle 重建成 VRM 1.0(glTF binary + VRMC_vrm)
# 座標系:Unity 左手 → glTF 右手,採 x 翻轉(位置 -x、四元數 (x,-y,-z,w)、三角形反繞向、UV v 翻轉)
import UnityPy, sys, json, struct, io, math
from UnityPy.helpers.MeshHelper import MeshHandler

BUNDLE = sys.argv[1]
OUT = sys.argv[2]
ROOT_NAME = sys.argv[3] if len(sys.argv) > 3 else "Vivian"

# 要收進 VRM 的蒙皮網格。Vivian 用固定清單(排除特效 MF*、道具 rod、關閉的 Nippless);
# 其他角色(Rosette_*)自動收:啟用中的 SMR、且骨數 > 10(排除槍等道具)。
VIVIAN_SMR = {"Body","bodyskin","hair","underware","collar","shawl","skart",
              "grove","shoes","bracelet","btfly_hairacs","hat","stocking","breast_cover"}
MORPH_MESHES = {"Body"}   # 只有臉需要 blendshape(VRM 表情)

env = UnityPy.load(BUNDLE)
# .assets 檔沒內嵌 MonoBehaviour typetree,掛上由 Managed DLL 生成的 generator(PhysBone 用)
import os
_d = os.path.dirname(os.path.abspath(BUNDLE))
while _d != "/":
    if os.path.isdir(os.path.join(_d, "Managed")):
        try:
            from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator
            gen = TypeTreeGenerator("6000.0.48f1")
            gen.load_local_dll_folder(os.path.join(_d, "Managed"))
            env.typetree_generator = gen
        except Exception as e:
            print("typetree generator 不可用:", e)
        break
    _d = os.path.dirname(_d)
objs = {o.path_id: o for o in env.objects}
tts = {}
def tt(pid):
    if pid not in tts:
        tts[pid] = objs[pid].read_typetree()
    return tts[pid]

# ---------- 蒐集 Transform / GameObject ----------
transforms = {o.path_id: tt(o.path_id) for o in env.objects if o.type.name == "Transform"}
def go_name(tr):
    return tt(tr["m_GameObject"]["m_PathID"])["m_Name"]

# 找角色根(不一定是場景根,例如 Rosette_Maid 掛在場景裡)
root_pid = None
for pid, tr in transforms.items():
    if go_name(tr) == ROOT_NAME:
        root_pid = pid
if root_pid is None:
    sys.exit(f"找不到 {ROOT_NAME} 根節點")

# 根子樹內的 transform 集合(限制 SMR / Avatar 都取這個實體的,場景裡可能有多套)
subtree = set()
def collect(pid):
    subtree.add(pid)
    for c in transforms[pid]["m_Children"]:
        if c["m_PathID"] in transforms: collect(c["m_PathID"])
sys.setrecursionlimit(10000)
collect(root_pid)

# 只收 Armature 子樹(骨架)進 glTF 節點;SMR 以獨立節點掛在根下
armature_pid = None
for c in transforms[root_pid]["m_Children"]:
    if go_name(transforms[c["m_PathID"]]) == "Armature":
        armature_pid = c["m_PathID"]

nodes = []          # glTF nodes
node_of_tr = {}     # transform path_id -> node index
path_of_tr = {}     # transform path_id -> "Armature/Hips/..." 完整路徑(對 Avatar TOS 用)

def conv_pos(p): return [-p["x"], p["y"], p["z"]]
def conv_rot(q): return [q["x"], -q["y"], -q["z"], q["w"]]
def conv_scale(s): return [s["x"], s["y"], s["z"]]

def add_subtree(pid, parent_path):
    tr = transforms[pid]
    name = go_name(tr)
    path = f"{parent_path}/{name}" if parent_path else name
    idx = len(nodes)
    nodes.append({
        "name": name,
        "translation": conv_pos(tr["m_LocalPosition"]),
        "rotation": conv_rot(tr["m_LocalRotation"]),
        "scale": conv_scale(tr["m_LocalScale"]),
    })
    node_of_tr[pid] = idx
    path_of_tr[pid] = path
    kids = []
    for c in tr["m_Children"]:
        cp = c["m_PathID"]
        if cp in transforms:
            kids.append(add_subtree(cp, path))
    if kids:
        nodes[idx]["children"] = kids
    return idx

arm_node = add_subtree(armature_pid, "")

# ---------- 二進位緩衝 ----------
buf = io.BytesIO()
accessors = []
bufferViews = []
def align(n=4):
    while buf.tell() % n: buf.write(b"\x00")
def add_accessor(data_bytes, comp_type, count, acc_type, target=None, minmax=None, normalized=False):
    align()
    off = buf.tell()
    buf.write(data_bytes)
    bv = {"buffer": 0, "byteOffset": off, "byteLength": len(data_bytes)}
    if target: bv["target"] = target
    bufferViews.append(bv)
    acc = {"bufferView": len(bufferViews)-1, "componentType": comp_type, "count": count, "type": acc_type}
    if minmax: acc["min"], acc["max"] = minmax
    if normalized: acc["normalized"] = True
    accessors.append(acc)
    return len(accessors)-1

F32, U32, U16 = 5126, 5125, 5123
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963

def pack_vec(data, fmt_each):  # data: list of tuples
    return b"".join(struct.pack(fmt_each, *v) for v in data)

# ---------- 貼圖 ----------
images = []
textures_json = []
samplers = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
tex_index_of = {}
def add_texture(tex_pid):
    if tex_pid in tex_index_of: return tex_index_of[tex_pid]
    t = objs[tex_pid].read()
    img = t.image
    bio = io.BytesIO()
    img.save(bio, format="PNG")
    png = bio.getvalue()
    align()
    off = buf.tell()
    buf.write(png)
    bufferViews.append({"buffer": 0, "byteOffset": off, "byteLength": len(png)})
    images.append({"name": t.m_Name, "mimeType": "image/png", "bufferView": len(bufferViews)-1})
    textures_json.append({"sampler": 0, "source": len(images)-1})
    tex_index_of[tex_pid] = len(textures_json)-1
    return tex_index_of[tex_pid]

# ---------- 材質 ----------
materials_json = []
mat_index_of = {}
def add_material(mat_pid):
    if mat_pid in mat_index_of: return mat_index_of[mat_pid]
    m = tt(mat_pid)
    name = m["m_Name"]
    texs = {k: v["m_Texture"]["m_PathID"] for k, v in m["m_SavedProperties"]["m_TexEnvs"]}
    main = texs.get("_MainTex")
    transparent = name.endswith("_T")
    mat = {
        "name": name,
        "pbrMetallicRoughness": {
            "baseColorFactor": [1, 1, 1, 1],
            "metallicFactor": 0.0,
            "roughnessFactor": 1.0,
        },
        "extensions": {"KHR_materials_unlit": {}},
        "alphaMode": "BLEND" if transparent else ("MASK" if name == "hair" else "OPAQUE"),
        "doubleSided": True,
    }
    if mat["alphaMode"] == "MASK": mat["alphaCutoff"] = 0.5
    if main and main in objs:
        mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": add_texture(main), "texCoord": 0}
    materials_json.append(mat)
    mat_index_of[mat_pid] = len(materials_json)-1
    return mat_index_of[mat_pid]

# ---------- 網格 + 蒙皮 ----------
meshes_json = []
skins_json = []
scene_children = [arm_node]
morph_node_info = {}  # mesh 名 -> (node index, [morph names])

def conv_matrix(e):
    # e: dict e00..e33(列 row 欄 col);x 翻轉 M*B*M,再轉 glTF column-major
    b = [[e[f"e{r}{c}"] for c in range(4)] for r in range(4)]
    for r in range(4):
        for c in range(4):
            if (r == 0) != (c == 0):
                b[r][c] = -b[r][c]
    out = []
    for c in range(4):
        for r in range(4):
            out.append(b[r][c])
    return out

smrs = [o for o in env.objects if o.type.name == "SkinnedMeshRenderer"]
for o in smrs:
    r = tt(o.path_id)
    go = tt(r["m_GameObject"]["m_PathID"])
    name = go["m_Name"]
    # 只收本實體子樹內的 SMR
    smr_tr = None
    for comp in go["m_Component"]:
        cp = comp["component"]["m_PathID"]
        if cp in transforms: smr_tr = cp
    if smr_tr not in subtree: continue
    if ROOT_NAME == "Vivian":
        if name not in VIVIAN_SMR: continue
    else:
        if not go["m_IsActive"]: continue
        if len(r["m_Bones"]) <= 10: continue
    mesh_obj = objs[r["m_Mesh"]["m_PathID"]]
    mesh = mesh_obj.read()
    mesh_tt = mesh_obj.read_typetree()
    h = MeshHandler(mesh)
    h.process()
    vcount = h.m_VertexCount
    pos = [(-v[0], v[1], v[2]) for v in h.m_Vertices]
    nrm = [(-v[0], v[1], v[2]) for v in h.m_Normals] if h.m_Normals else None
    uv  = [(v[0], 1.0 - v[1]) for v in h.m_UV0] if h.m_UV0 else None
    def pad4(vs, fill):
        if vs is None: return None
        return [tuple(v) + (fill,) * (4 - len(v)) if len(v) < 4 else tuple(v[:4]) for v in vs]
    ji  = pad4(h.m_BoneIndices, 0)
    jw  = pad4(h.m_BoneWeights, 0.0)
    if ji is not None and jw is None:
        # 單骨蒙皮:權重隱含為 1
        jw = [(1.0, 0.0, 0.0, 0.0)] * len(ji)

    xs=[p[0] for p in pos]; ys=[p[1] for p in pos]; zs=[p[2] for p in pos]
    a_pos = add_accessor(pack_vec(pos, "<3f"), F32, vcount, "VEC3", ARRAY_BUFFER,
                         ([min(xs),min(ys),min(zs)],[max(xs),max(ys),max(zs)]))
    a_nrm = add_accessor(pack_vec(nrm, "<3f"), F32, vcount, "VEC3", ARRAY_BUFFER) if nrm else None
    a_uv  = add_accessor(pack_vec(uv, "<2f"), F32, vcount, "VEC2", ARRAY_BUFFER) if uv else None
    a_ji  = add_accessor(pack_vec(ji, "<4H"), U16, vcount, "VEC4", ARRAY_BUFFER) if ji else None
    a_jw  = add_accessor(pack_vec(jw, "<4f"), F32, vcount, "VEC4", ARRAY_BUFFER) if jw else None

    # 材質(依 submesh 順序)
    prim_mats = [add_material(mm["m_PathID"]) for mm in r["m_Materials"] if mm["m_PathID"] in objs]

    # blendshape(只做臉)
    targets = []
    target_names = []
    if name in MORPH_MESHES:
        shapes = mesh_tt["m_Shapes"]
        sverts = shapes["vertices"]
        for ch in shapes["channels"]:
            fi = ch["frameIndex"]; fc = ch["frameCount"]
            sh = shapes["shapes"][fi + fc - 1]  # 取最後一格(全量)
            delta = [(0.0,0.0,0.0)] * vcount
            first, cnt = sh["firstVertex"], sh["vertexCount"]
            for k in range(first, first+cnt):
                bv = sverts[k]
                v = bv["vertex"]
                delta[bv["index"]] = (-v["x"], v["y"], v["z"])
            dxs=[d[0] for d in delta]; dys=[d[1] for d in delta]; dzs=[d[2] for d in delta]
            a_t = add_accessor(pack_vec(delta, "<3f"), F32, vcount, "VEC3", ARRAY_BUFFER,
                               ([min(dxs),min(dys),min(dzs)],[max(dxs),max(dys),max(dzs)]))
            targets.append({"POSITION": a_t})
            target_names.append(ch["name"])

    # 三角形(依 submesh),反繞向
    tri_sets = h.get_triangles()
    prims = []
    for si, tris in enumerate(tri_sets):
        idx = []
        for t in tris:
            idx.extend((t[0], t[2], t[1]))
        a_idx = add_accessor(struct.pack(f"<{len(idx)}I", *idx), U32, len(idx), "SCALAR", ELEMENT_ARRAY_BUFFER)
        attrs = {"POSITION": a_pos}
        if a_nrm is not None: attrs["NORMAL"] = a_nrm
        if a_uv is not None: attrs["TEXCOORD_0"] = a_uv
        if a_ji is not None: attrs["JOINTS_0"] = a_ji
        if a_jw is not None: attrs["WEIGHTS_0"] = a_jw
        p = {"attributes": attrs, "indices": a_idx, "mode": 4}
        if si < len(prim_mats): p["material"] = prim_mats[si]
        if targets: p["targets"] = targets
        prims.append(p)

    gmesh = {"name": name, "primitives": prims}
    if target_names:
        gmesh["extras"] = {"targetNames": target_names}
    meshes_json.append(gmesh)

    # skin
    joints = [node_of_tr[b["m_PathID"]] for b in r["m_Bones"]]
    ibm = b"".join(struct.pack("<16f", *conv_matrix(e)) for e in mesh_tt["m_BindPose"])
    a_ibm = add_accessor(ibm, F32, len(joints), "MAT4")
    skins_json.append({"joints": joints, "inverseBindMatrices": a_ibm})

    node_idx = len(nodes)
    nodes.append({"name": name, "mesh": len(meshes_json)-1, "skin": len(skins_json)-1})
    scene_children.append(node_idx)
    if target_names:
        morph_node_info[name] = (node_idx, target_names)

# ---------- Avatar → humanoid ----------
avatar_tt = None
for o in env.objects:
    if o.type.name == "Avatar":
        avatar_tt = o.read_typetree()
if avatar_tt is None: sys.exit("找不到 Avatar")

def unwrap(x):
    return x["data"] if isinstance(x, dict) and set(x.keys()) == {"data"} else x

av = avatar_tt["m_Avatar"]
tos = dict(avatar_tt["m_TOS"])
human = unwrap(av["m_Human"])
hskel = unwrap(human["m_Skeleton"])
ids = hskel["m_ID"]
bone_index = human["m_HumanBoneIndex"]

# mecanim 內部骨序(m_HumanBoneIndex 對應;注意 UpperChest 插在 Chest 之後第 9 位,
# 與 C# HumanTrait 列舉順序不同——用錯會讓 Neck 以後全部錯位一格)
HUMAN_BONES = ["Hips","LeftUpperLeg","RightUpperLeg","LeftLowerLeg","RightLowerLeg",
 "LeftFoot","RightFoot","Spine","Chest","UpperChest","Neck","Head","LeftShoulder","RightShoulder",
 "LeftUpperArm","RightUpperArm","LeftLowerArm","RightLowerArm","LeftHand","RightHand",
 "LeftToes","RightToes","LeftEye","RightEye","Jaw"]
# Unity → VRM1 命名
def vrm1_name(u):
    m = {"Hips":"hips","Spine":"spine","Chest":"chest","UpperChest":"upperChest","Neck":"neck","Head":"head","Jaw":"jaw",
         "LeftEye":"leftEye","RightEye":"rightEye",
         "LeftShoulder":"leftShoulder","LeftUpperArm":"leftUpperArm","LeftLowerArm":"leftLowerArm","LeftHand":"leftHand",
         "RightShoulder":"rightShoulder","RightUpperArm":"rightUpperArm","RightLowerArm":"rightLowerArm","RightHand":"rightHand",
         "LeftUpperLeg":"leftUpperLeg","LeftLowerLeg":"leftLowerLeg","LeftFoot":"leftFoot","LeftToes":"leftToes",
         "RightUpperLeg":"rightUpperLeg","RightLowerLeg":"rightLowerLeg","RightFoot":"rightFoot","RightToes":"rightToes"}
    return m.get(u)

# path 字串 → node
node_of_path = {p: i for pid, i in node_of_tr.items() for p in [path_of_tr[pid]]}
def node_from_skel_index(si):
    hid = ids[si]
    path = tos.get(hid)
    if path is None: return None
    return node_of_path.get(path)

human_bones = {}
for k, si in enumerate(bone_index):
    if si < 0 or k >= len(HUMAN_BONES): continue
    v = vrm1_name(HUMAN_BONES[k])
    if not v: continue
    n = node_from_skel_index(si)
    if n is not None:
        human_bones[v] = {"node": n}

# 手指:m_LeftHand / m_RightHand 的 m_HandBoneIndex(Thumb1..3, Index.., Middle.., Ring.., Little..)
FINGERS = ["ThumbMetacarpal","ThumbProximal","ThumbDistal",
           "IndexProximal","IndexIntermediate","IndexDistal",
           "MiddleProximal","MiddleIntermediate","MiddleDistal",
           "RingProximal","RingIntermediate","RingDistal",
           "LittleProximal","LittleIntermediate","LittleDistal"]
for side, key in (("left","m_LeftHand"), ("right","m_RightHand")):
    hand = unwrap(human.get(key)) if human.get(key) else None
    if not hand: continue
    hbi = hand.get("m_HandBoneIndex") or []
    for j, si in enumerate(hbi):
        if si < 0 or j >= 15: continue
        n = node_from_skel_index(si)
        if n is not None:
            human_bones[side + FINGERS[j]] = {"node": n}

required = ["hips","spine","head","leftUpperArm","leftLowerArm","leftHand",
            "rightUpperArm","rightLowerArm","rightHand","leftUpperLeg","leftLowerLeg","leftFoot",
            "rightUpperLeg","rightLowerLeg","rightFoot"]
missing = [b for b in required if b not in human_bones]
if missing:
    print("警告:缺 humanoid 必要骨:", missing)

# ---------- VRM 表情 ----------
# 每個部位給候選清單(名稱, 權重),取第一個存在的 blendshape;Vivian 與 Rosette 命名不同
def expr(mesh_name, *parts):
    node_idx, names = morph_node_info[mesh_name]
    binds = []
    for cands in parts:
        for sn, w in cands:
            if sn == "skip":
                break
            if sn in names:
                binds.append({"node": node_idx, "index": names.index(sn), "weight": w})
                break
        else:
            print("警告:整組候選都找不到:", [c[0] for c in cands])
    return {"morphTargetBinds": binds, "isBinary": False,
            "overrideBlink": "none", "overrideLookAt": "none", "overrideMouth": "none"}

def P(*cands): return list(cands)

expressions = {"preset": {
    "happy":     expr("Body", P(("笑い", 1.0)), P(("mouth_smile", 0.7))),
    "angry":     expr("Body", P(("eye_anger", 1.0), ("eye_jito_L", 0.7)), P(("eye_jito_R", 0.7), ("skip", 0)),
                         P(("eyebrow_anger", 1.0), ("eyebrow_angry_L", 1.0)), P(("eyebrow_angry_R", 1.0), ("skip", 0)),
                         P(("mouth_sullenness", 0.8), ("mouth_sullen", 0.8))),
    "sad":       expr("Body", P(("eye_tare", 1.0), ("困る", 1.0)),
                         P(("eyebrow_sad", 1.0), ("eyebrow_sullen_L", 1.0)), P(("eyebrow_sullen_R", 1.0), ("skip", 0)),
                         P(("口角下げ", 0.7), ("mouth_e-", 0.7))),
    "relaxed":   expr("Body", P(("なごみ", 1.0))),
    "surprised": expr("Body", P(("eye_surprise", 1.0), ("eye_surprise_L", 1.0)), P(("eye_surprise_R", 1.0), ("skip", 0)),
                         P(("eyebrow_up_L", 1.0)), P(("eyebrow_up_R", 1.0)),
                         P(("mouth_o", 0.7), ("お", 0.6))),
    "neutral":   expr("Body"),
    "aa": expr("Body", P(("あ", 1.0))),
    "ih": expr("Body", P(("い", 1.0))),
    "ou": expr("Body", P(("う", 1.0))),
    "ee": expr("Body", P(("え", 1.0))),
    "oh": expr("Body", P(("お", 1.0))),
    "blink": expr("Body", P(("まばたき", 1.0))),
    "blinkLeft": expr("Body", P(("vrc.blink_left", 1.0))),
    "blinkRight": expr("Body", P(("vrc.blink_right", 1.0))),
}}

# ---------- VRCPhysBone → VRMC_springBone ----------
# 以欄位特徵辨識 PhysBone(不依賴 MonoScript 解析);鏈:rootTransform 往下走到葉,
# 根有多個子時每條子鏈各自成 spring(根不當 joint,免得共用節點)
springs = []
spring_used = set()
def phys_params(pb):
    pull = pb.get("pull", 0.2); spring = pb.get("spring", 0.2)
    grav = pb.get("gravity", 0.0); radius = pb.get("radius", 0.0)
    return {
        "hitRadius": max(radius, 0.005),
        "stiffness": max(0.2, min(4.0, pull * 4.0)),
        "gravityPower": max(0.0, min(1.0, abs(grav))),
        "gravityDir": [0, -1, 0],
        "dragForce": max(0.1, min(0.6, 1.0 - spring * 0.7)),
    }

for o in env.objects:
    if o.type.name != "MonoBehaviour": continue
    try:
        pb = o.read_typetree()
    except Exception:
        continue
    if not {"pull", "spring", "stiffness", "rootTransform", "ignoreTransforms"} <= set(pb.keys()):
        continue
    # 掛載的 GO 要在本實體子樹內
    go_pid = pb["m_GameObject"]["m_PathID"]
    host_tr = None
    for comp in tt(go_pid)["m_Component"]:
        cp = comp["component"]["m_PathID"]
        if cp in transforms: host_tr = cp
    root_tr = pb["rootTransform"]["m_PathID"] or host_tr
    if root_tr not in subtree or root_tr not in node_of_tr: continue
    ignored = set()
    def mark_ignored(pid):
        ignored.add(pid)
        for c in transforms[pid]["m_Children"]:
            if c["m_PathID"] in transforms: mark_ignored(c["m_PathID"])
    for ig in pb["ignoreTransforms"]:
        if ig["m_PathID"] in transforms: mark_ignored(ig["m_PathID"])
    params = phys_params(pb)
    def chains_from(pid):
        # 回傳自 pid 起的所有到葉節點的路徑(不含被忽略的)
        kids = [c["m_PathID"] for c in transforms[pid]["m_Children"]
                if c["m_PathID"] in transforms and c["m_PathID"] not in ignored]
        if not kids:
            return [[pid]]
        out = []
        for k in kids:
            for ch in chains_from(k):
                out.append([pid] + ch)
        return out
    root_kids = [c["m_PathID"] for c in transforms[root_tr]["m_Children"]
                 if c["m_PathID"] in transforms and c["m_PathID"] not in ignored]
    if not root_kids: continue
    if len(root_kids) == 1:
        chain_list = chains_from(root_tr)
    else:
        chain_list = [ch for k in root_kids for ch in chains_from(k)]
    for ch in chain_list:
        if len(ch) < 2: continue
        if any(p in spring_used for p in ch): continue  # 避免節點被兩條 spring 重複模擬
        joints = [dict(node=node_of_tr[p], **params) for p in ch if p in node_of_tr]
        if len(joints) >= 2:
            springs.append({"name": go_name(transforms[ch[0]]), "joints": joints})
            spring_used.update(ch)

# ---------- 組 glTF ----------
align()
bin_data = buf.getvalue()
gltf = {
    "asset": {"version": "2.0", "generator": "yourmom-extract"},
    "scene": 0,
    "scenes": [{"name": "Vivian", "nodes": scene_children}],
    "nodes": nodes,
    "meshes": meshes_json,
    "skins": skins_json,
    "accessors": accessors,
    "bufferViews": bufferViews,
    "buffers": [{"byteLength": len(bin_data)}],
    "materials": materials_json,
    "textures": textures_json,
    "images": images,
    "samplers": samplers,
    "extensionsUsed": ["KHR_materials_unlit", "VRMC_vrm"] + (["VRMC_springBone"] if springs else []),
    "extensions": {
        **({"VRMC_springBone": {"specVersion": "1.0", "colliders": [], "colliderGroups": [], "springs": springs}} if springs else {}),
        "VRMC_vrm": {
            "specVersion": "1.0",
            "meta": {
                "name": ROOT_NAME,
                "version": "1.0",
                "authors": ["extracted from Your Mom (personal use)"],
                "licenseUrl": "https://vrm.dev/licenses/1.0/",
                "avatarPermission": "onlyAuthor",
                "commercialUsage": "personalNonProfit",
                "creditNotation": "required",
                "modification": "prohibited",
            },
            "humanoid": {"humanBones": human_bones},
            "expressions": expressions,
        }
    },
}

js = json.dumps(gltf, separators=(",", ":")).encode()
js += b" " * ((4 - len(js) % 4) % 4)
glb = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + 8 + len(bin_data))
glb += struct.pack("<II", len(js), 0x4E4F534A) + js
glb += struct.pack("<II", len(bin_data), 0x004E4942) + bin_data
with open(OUT, "wb") as f:
    f.write(glb)
print(f"完成:{OUT}  nodes={len(nodes)} meshes={len(meshes_json)} mats={len(materials_json)} texs={len(textures_json)} humanBones={len(human_bones)} springs={len(springs)} size={len(glb)/1e6:.1f}MB")
