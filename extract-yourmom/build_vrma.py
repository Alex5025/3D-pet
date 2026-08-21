# Unity humanoid muscle clip → VRMA(VRMC_vrm_animation 1.0)
# 演算法依據:lox9973/uvw.js HumanPoseHandler(muscle 數學)、AssetStudio AnimationClip.cs(curve 解碼)、
# AssetRipper HumanoidMuscleType(attribute 佈局)。座標系:Unity 左手 → glTF 右手 x 翻轉。
import UnityPy, sys, json, struct, math, os
from bisect import bisect_right

APP = sys.argv[1]            # .../Data 目錄
OUTDIR = sys.argv[2]
ONLY = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else None
FPS = 30.0

# ---------- 四元數 (x,y,z,w),Unity 慣例:a*b = 先 b 後 a ----------
def qmul(a, b):
    ax,ay,az,aw = a; bx,by,bz,bw = b
    return (aw*bx + ax*bw + ay*bz - az*by,
            aw*by + ay*bw + az*bx - ax*bz,
            aw*bz + az*bw + ax*by - ay*bx,
            aw*bw - ax*bx - ay*by - az*bz)
def qinv(q): x,y,z,w = q; return (-x,-y,-z,w)
def qnorm(q):
    n = math.sqrt(sum(c*c for c in q)) or 1.0
    return tuple(c/n for c in q)
def qrot(q, v):
    x,y,z,w = q; vx,vy,vz = v
    tx,ty,tz = 2*(y*vz-z*vy), 2*(z*vx-x*vz), 2*(x*vy-y*vx)
    return (vx + w*tx + y*tz - z*ty,
            vy + w*ty + z*tx - x*tz,
            vz + w*tz + x*ty - y*tx)
def swing_twist(x, y, z):
    yz = math.hypot(y, z)
    sinc = 0.5 if abs(yz) < 1e-8 else math.sin(yz/2)/yz
    sw, tw, tx = math.cos(yz/2), math.cos(x/2), math.sin(x/2)
    return (sw*tx, (z*tx + y*tw)*sinc, (z*tw - y*tx)*sinc, sw*tw)

# ---------- muscle → (bone, axis);索引 = HumanBodyBones ----------
MUSCLE_FROM_BONE = [
 [-1,-1,-1],
 [23,22,21],[31,30,29],
 [25,-1,24],[33,-1,32],
 [-1,27,26],[-1,35,34],
 [2,1,0],[5,4,3],
 [11,10,9],[14,13,12],
 [-1,38,37],[-1,47,46],
 [41,40,39],[50,49,48],
 [43,-1,42],[52,-1,51],
 [-1,45,44],[-1,54,53],
 [-1,-1,28],[-1,-1,36],
 [-1,16,15],[-1,18,17],
 [-1,20,19],
 [-1,56,55],[-1,-1,57],[-1,-1,58],[-1,60,59],[-1,-1,61],[-1,-1,62],
 [-1,64,63],[-1,-1,65],[-1,-1,66],[-1,68,67],[-1,-1,69],[-1,-1,70],
 [-1,72,71],[-1,-1,73],[-1,-1,74],[-1,76,75],[-1,-1,77],[-1,-1,78],
 [-1,80,79],[-1,-1,81],[-1,-1,82],[-1,84,83],[-1,-1,85],[-1,-1,86],
 [-1,88,87],[-1,-1,89],[-1,-1,90],[-1,92,91],[-1,-1,93],[-1,-1,94],
 [8,7,6],
]
MECANIM_BODY = [0,1,2,3,4,5,6,7,8,54,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]
TWIST_CHAINS = [(13,15,17), (14,16,18), (1,3,5), (2,4,6)]
VRM1_OF_HBB = {0:"hips",1:"leftUpperLeg",2:"rightUpperLeg",3:"leftLowerLeg",4:"rightLowerLeg",
 5:"leftFoot",6:"rightFoot",7:"spine",8:"chest",9:"neck",10:"head",11:"leftShoulder",12:"rightShoulder",
 13:"leftUpperArm",14:"rightUpperArm",15:"leftLowerArm",16:"rightLowerArm",17:"leftHand",18:"rightHand",
 19:"leftToes",20:"rightToes",21:"leftEye",22:"rightEye",23:"jaw",54:"upperChest"}
_F = ["Thumb","Index","Middle","Ring","Little"]
_S = [["Metacarpal","Proximal","Distal"] if f=="Thumb" else ["Proximal","Intermediate","Distal"] for f in _F]
for fi in range(5):
    for si in range(3):
        VRM1_OF_HBB[24 + fi*3 + si] = "left" + _F[fi] + _S[fi][si]
        VRM1_OF_HBB[39 + fi*3 + si] = "right" + _F[fi] + _S[fi][si]

def unwrap(x):
    return x["data"] if isinstance(x, dict) and set(x.keys()) == {"data"} else x
def qd(o): return (o["x"], o["y"], o["z"], o["w"])
def vd(o): return (o["x"], o["y"], o["z"])

# ---------- Avatar ----------
class HumanAvatar:
    def __init__(self, avatar_tt):
        av = unwrap(avatar_tt["m_Avatar"])
        hu = unwrap(av["m_Human"])
        sk = unwrap(hu["m_Skeleton"])
        self.nodes = sk["m_Node"]
        self.axes_arr = sk["m_AxesArray"]
        self.ids = sk["m_ID"]
        self.pose = unwrap(hu["m_SkeletonPose"])["m_X"]
        self.tos = dict(avatar_tt["m_TOS"])
        self.scale = hu["m_Scale"]
        self.mass = hu["m_HumanBoneMass"]
        self.twist_w = {13: hu["m_ArmTwist"], 14: hu["m_ArmTwist"],
                        15: hu["m_ForeArmTwist"], 16: hu["m_ForeArmTwist"],
                        1: hu["m_UpperLegTwist"], 2: hu["m_UpperLegTwist"],
                        3: hu["m_LegTwist"], 4: hu["m_LegTwist"]}
        self.bone_node = {}
        self.body_index = hu["m_HumanBoneIndex"]
        for i, ni in enumerate(self.body_index):
            if ni >= 0: self.bone_node[MECANIM_BODY[i]] = ni
        for i, ni in enumerate(unwrap(hu["m_LeftHand"])["m_HandBoneIndex"]):
            if ni >= 0: self.bone_node[24 + i] = ni
        for i, ni in enumerate(unwrap(hu["m_RightHand"])["m_HandBoneIndex"]):
            if ni >= 0: self.bone_node[39 + i] = ni
        self.node_bone = {v: k for k, v in self.bone_node.items()}
        # rest local TRS per node
        self.rest = []
        for x in self.pose:
            t = x["t"]; q = x["q"]; s = x["s"]
            self.rest.append((vd(t), qd(q), vd(s)))
        self.names = []
        for hid in self.ids:
            p = self.tos.get(hid, "")
            self.names.append(p.rsplit("/", 1)[-1] if p else "node")

    def axes_of(self, bone):
        ni = self.bone_node.get(bone)
        if ni is None: return None
        ai = self.nodes[ni]["m_AxesId"]
        if ai < 0: return None
        a = self.axes_arr[ai]
        lim = a["m_Limit"]
        return dict(preQ=qd(a["m_PreQ"]), postQ=qd(a["m_PostQ"]),
                    sgn=vd(a["m_Sgn"]), mn=vd(lim["m_Min"]), mx=vd(lim["m_Max"]),
                    length=a["m_Length"])

def muscle_local_rotations(av, muscles):
    ang = {}
    for bone in range(55):
        ax = av.axes_of(bone)
        if ax is None: continue
        a = [0.0, 0.0, 0.0]
        for j in range(3):
            mi = MUSCLE_FROM_BONE[bone][j]
            m = muscles.get(mi, 0.0) if mi >= 0 else 0.0
            lim = ax["mx"][j] if m >= 0 else -ax["mn"][j]
            a[j] = m * lim * ax["sgn"][j]
        ang[bone] = (a, ax)
    out, push = {}, {}
    twist_parent = {}
    for chain in TWIST_CHAINS:
        for i in range(1, len(chain)):
            twist_parent[chain[i]] = chain[i-1]
    # 依鏈序處理:先鏈首再鏈中/末(dict 遍歷順序不保證,分兩批)
    order = sorted(ang.keys(), key=lambda b: (b in twist_parent, twist_parent.get(b, -1)))
    for bone in order:
        a, ax = ang[bone]
        x, y, z = a
        w = av.twist_w.get(bone)
        q = qmul(ax["preQ"], qmul(swing_twist(x * (w if w is not None else 1.0), y, z), qinv(ax["postQ"])))
        p = twist_parent.get(bone)
        if p is not None and p in push:
            q = qmul(push[p], q)
        if w is not None:
            push[bone] = qmul(ax["postQ"], qmul(swing_twist(x * (1 - w), 0, 0), qinv(ax["postQ"])))
        out[bone] = q
    return out

# ---------- curve 解碼 ----------
def parse_streamed(uints):
    buf = struct.pack("<%dI" % len(uints), *uints)
    curves, off, n = {}, 0, len(buf)
    while off + 8 <= n:
        time, cnt = struct.unpack_from("<fi", buf, off); off += 8
        for _ in range(cnt):
            idx, c0, c1, c2, c3 = struct.unpack_from("<i4f", buf, off); off += 20
            curves.setdefault(idx, []).append((time, (c0, c1, c2, c3)))
    return {k: (
        [t for t, _ in v],
        [c for _, c in v],
    ) for k, v in curves.items()}

def eval_streamed(curve, t):
    times, coeffs = curve
    i = bisect_right(times, t) - 1
    if i < 0: i = 0
    t0 = times[i]; c0, c1, c2, c3 = coeffs[i]
    if (c0 == 0 and c1 == 0 and c2 == 0) or math.isinf(t0):
        return c3
    x = t - t0
    if i + 1 < len(times):
        x = min(x, times[i+1] - t0)
    return ((c0*x + c1)*x + c2)*x + c3

def slot_table(binds):
    out, cur = [], 0
    for b in binds:
        n = ({1:3, 2:4, 3:3, 4:3}.get(b["attribute"], 1) if b["typeID"] == 4 else 1)
        out.append((cur, b)); cur += n
    return out

# ---------- 主流程 ----------
def convert_clip(tt_clip, av, out_path):
    mc = unwrap(tt_clip["m_MuscleClip"])
    clip = unwrap(mc["m_Clip"])
    sc = clip["m_StreamedClip"]; dc = clip["m_DenseClip"]; cc = clip["m_ConstantClip"]
    streamed = parse_streamed(sc["data"])
    n_stream = sc["curveCount"]
    n_dense = dc["m_CurveCount"]
    dense_arr = dc["m_SampleArray"]
    const_arr = cc["data"]
    binds = tt_clip["m_ClipBindingConstant"]["genericBindings"]
    slots = slot_table(binds)
    if mc.get("m_Mirror"):
        print("  警告:m_Mirror=True,未處理鏡像,結果左右相反")

    def sample_slot(slot, t):
        if slot < n_stream:
            c = streamed.get(slot)
            return eval_streamed(c, t) if c else 0.0
        s = slot - n_stream
        if s < n_dense:
            f = (t - dc["m_BeginTime"]) * dc["m_SampleRate"]
            f = max(0.0, min(f, dc["m_FrameCount"] - 1))
            f0 = int(f); f1 = min(f0 + 1, dc["m_FrameCount"] - 1); u = f - f0
            return dense_arr[f0*n_dense + s]*(1-u) + dense_arr[f1*n_dense + s]*u
        s -= n_dense
        if s < len(const_arr):
            return const_arr[s]
        return 0.0

    human_slots = [(slot, b["attribute"]) for slot, b in slots if b["typeID"] == 95 and b["path"] == 0 and b["attribute"] < 137]

    # 部分 clip(手勢/表情遮罩)只繫部分肌肉:只輸出有曲線的骨,沒 RootT/Q 就不動 hips,
    # 播放時身體其餘部位維持原姿勢
    bone_of_muscle = {}
    for b_, axes_ in enumerate(MUSCLE_FROM_BONE):
        for mi_ in axes_:
            if mi_ >= 0: bone_of_muscle[mi_] = b_
    animated_bones = set()
    has_root = False
    for _, attr in human_slots:
        if 7 <= attr <= 13: has_root = True
        if attr >= 42:
            b_ = bone_of_muscle.get(attr - 42)
            if b_ is not None: animated_bones.add(b_)
    for chain in TWIST_CHAINS:   # twist 會沿鏈下推,鏈上有動就整條輸出
        if any(c in animated_bones for c in chain):
            animated_bones.update(chain)

    t0, t1 = mc["m_StartTime"], mc["m_StopTime"]
    n_frames = max(2, int(round((t1 - t0) * FPS)) + 1)
    times = [min(t0 + i / FPS, t1) for i in range(n_frames)]
    static_pose = (t1 - t0) < 1.0 / FPS   # 零時長/單幀 clip:定格姿勢

    # FK 準備
    n_nodes = len(av.nodes)
    children = {}
    root_nodes = []
    for i, nd in enumerate(av.nodes):
        p = nd["m_ParentId"]
        if p < 0: root_nodes.append(i)
        else: children.setdefault(p, []).append(i)

    hips_node = av.bone_node[0]

    # rest 世界姿勢(正規化基準)
    restWpos = [None]*n_nodes; restWrot = [None]*n_nodes
    def fk_rest(i, pp, pq):
        rt, rq, rs = av.rest[i]
        wr = qmul(pq, rq)
        wp = tuple(p + d for p, d in zip(pp, qrot(pq, rt)))
        restWpos[i] = wp; restWrot[i] = wr
        for c in children.get(i, []): fk_rest(c, wp, wr)
    for r in root_nodes:
        fk_rest(r, (0,0,0), (0,0,0,1))

    # 每骨動畫軌(正規化空間:VRMA 骨架 rest 旋轉皆 identity,
    # 軌值 = W_rest(parent)⊗inv(W_t(parent)) ⊗ W_t(node)⊗inv(W_rest(node));
    # three-vrm-animation 的重定向假設正是這種正規化骨架)
    rot_tracks = {b: [] for b in av.bone_node
                  if (b in animated_bones) or (b == 0 and has_root)}   # bone -> [quat]
    hips_t_track = []

    for t in times:
        muscles = {}
        seven = {}
        for slot, attr in human_slots:
            v = sample_slot(slot, t)
            if attr < 42:
                seven.setdefault(attr // 7, [0,0,0, 0,0,0,1])[attr % 7] = v
            else:
                muscles[attr - 42] = v
        root7 = seven.get(1, [0,0,0, 0,0,0,1])
        root_t = tuple(root7[0:3]); root_q = qnorm(tuple(root7[3:7]))
        local_rot = muscle_local_rotations(av, muscles)

        # FK(local = rest,human 骨 rotation 取代)
        wpos = [None]*n_nodes; wrot = [None]*n_nodes
        def fk(i, pp, pq):
            rt, rq, rs = av.rest[i]
            b = av.node_bone.get(i)
            lq = local_rot.get(b, rq) if b is not None else rq
            wr = qmul(pq, lq)
            wp = tuple(p + d for p, d in zip(pp, qrot(pq, rt)))
            wpos[i] = wp; wrot[i] = wr
            for c in children.get(i, []):
                fk(c, wp, wr)
        for r in root_nodes:
            fk(r, (0,0,0), (0,0,0,1))

        if not has_root:
            for b in rot_tracks:
                ni = av.bone_node[b]
                p = av.nodes[ni]["m_ParentId"]
                rot_tracks[b].append(qmul(qmul(restWrot[p], qinv(wrot[p])), qmul(wrot[ni], qinv(restWrot[ni]))))
            continue

        # 質心
        limb = {b: wpos[av.bone_node[b]] for b in (13,14,1,2)}
        xv = tuple((limb[14][k]+limb[2][k]) - (limb[13][k]+limb[1][k]) for k in range(3))
        yv = tuple((limb[13][k]+limb[14][k]) - (limb[1][k]+limb[2][k]) for k in range(3))
        def cross(a,b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
        def norm(v):
            l = math.sqrt(sum(c*c for c in v)) or 1.0
            return tuple(c/l for c in v)
        zv = norm(cross(xv, yv)); yv = norm(yv); xv = cross(yv, zv)
        # 基底 → 四元數(行=軸)
        m00,m10,m20 = xv; m01,m11,m21 = yv; m02,m12,m22 = zv
        tr = m00+m11+m22
        if tr > 0:
            s = math.sqrt(tr+1)*2
            massQ = ((m21-m12)/s, (m02-m20)/s, (m10-m01)/s, s/4)
        elif m00 > m11 and m00 > m22:
            s = math.sqrt(1+m00-m11-m22)*2
            massQ = (s/4, (m01+m10)/s, (m02+m20)/s, (m21-m12)/s)
        elif m11 > m22:
            s = math.sqrt(1+m11-m00-m22)*2
            massQ = ((m01+m10)/s, s/4, (m12+m21)/s, (m02-m20)/s)
        else:
            s = math.sqrt(1+m22-m00-m11)*2
            massQ = ((m02+m20)/s, (m12+m21)/s, s/4, (m10-m01)/s)
        massQ = qnorm(massQ)
        tot = 0.0; acc = [0.0,0.0,0.0]
        for i, ni in enumerate(av.body_index):
            if ni < 0: continue
            b = MECANIM_BODY[i]
            m = av.mass[i]
            if m <= 0: continue
            ax = av.axes_of(b)
            half = qrot(wrot[ni], qrot(ax["postQ"], (ax["length"]/2, 0, 0))) if ax else (0,0,0)
            for k in range(3): acc[k] += m * (wpos[ni][k] + half[k])
            tot += m
        massT = tuple(a/tot for a in acc)

        targetT = tuple(c * av.scale for c in root_t)
        deltaQ = qmul(root_q, qinv(massQ))
        hw_rot = qmul(deltaQ, wrot[hips_node])
        off = qrot(deltaQ, tuple(massT[j] - wpos[hips_node][j] for j in range(3)))
        hw_pos = tuple(targetT[k] - off[k] for k in range(3))

        # 正規化軌值
        pid = av.nodes[hips_node]["m_ParentId"]
        for b in rot_tracks:
            ni = av.bone_node[b]
            if b == 0:
                q = qmul(hw_rot, qinv(restWrot[ni]))
            else:
                p = av.nodes[ni]["m_ParentId"]
                q = qmul(qmul(restWrot[p], qinv(wrot[p])), qmul(wrot[ni], qinv(restWrot[ni])))
            rot_tracks[b].append(q)
        parent_pos = restWpos[pid] if pid >= 0 else (0,0,0)
        hips_t_track.append(tuple(hw_pos[k] - parent_pos[k] for k in range(3)))

    # ---------- 寫 VRMA(glTF) ----------
    import io
    buf = io.BytesIO()
    accessors = []; bufferViews = []
    def add_acc(data, comp, count, typ, minmax=None):
        while buf.tell() % 4: buf.write(b"\x00")
        off = buf.tell(); buf.write(data)
        bufferViews.append({"buffer":0,"byteOffset":off,"byteLength":len(data)})
        a = {"bufferView":len(bufferViews)-1,"componentType":comp,"count":count,"type":typ}
        if minmax: a["min"],a["max"] = minmax
        accessors.append(a); return len(accessors)-1

    # 節點(正規化:位移 = rest 世界位置差、旋轉 identity;x 翻轉)
    gnodes = []
    for i in range(n_nodes):
        p = av.nodes[i]["m_ParentId"]
        pp = restWpos[p] if p >= 0 else (0,0,0)
        off = tuple(restWpos[i][k] - pp[k] for k in range(3))
        gnodes.append({"name": av.names[i] or f"n{i}",
                       "translation": [-off[0], off[1], off[2]]})
    for p, cs in children.items():
        gnodes[p]["children"] = cs

    rel = [t - times[0] for t in times]
    if static_pose:
        # 兩幀同值撐出最小時長,避免 sampler 時間重複
        rel = [0.0, 1.0 / FPS]
    time_acc = add_acc(struct.pack(f"<{len(rel)}f", *rel), 5126, len(rel), "SCALAR", ([rel[0]],[rel[-1]]))
    channels = []; samplers = []
    def add_chan(node, path, data_bytes, count, typ):
        out_acc = add_acc(data_bytes, 5126, count, typ)
        samplers.append({"input": time_acc, "output": out_acc, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers)-1, "target": {"node": node, "path": path}})

    for b, track in rot_tracks.items():
        ni = av.bone_node[b]
        conv = [(q[0], -q[1], -q[2], q[3]) for q in map(qnorm, track)]
        add_chan(ni, "rotation", b"".join(struct.pack("<4f", *q) for q in conv), len(conv), "VEC4")
    if hips_t_track:
        conv_t = [(-p[0], p[1], p[2]) for p in hips_t_track]
        add_chan(av.bone_node[0], "translation", b"".join(struct.pack("<3f", *p) for p in conv_t), len(conv_t), "VEC3")

    human_bones = {}
    for b, ni in av.bone_node.items():
        nm = VRM1_OF_HBB.get(b)
        if nm: human_bones[nm] = {"node": ni}

    while buf.tell() % 4: buf.write(b"\x00")
    bin_data = buf.getvalue()
    gltf = {
        "asset": {"version": "2.0", "generator": "yourmom-extract-vrma"},
        "scene": 0,
        "scenes": [{"nodes": root_nodes}],
        "nodes": gnodes,
        "accessors": accessors,
        "bufferViews": bufferViews,
        "buffers": [{"byteLength": len(bin_data)}],
        "animations": [{"name": tt_clip["m_Name"], "channels": channels, "samplers": samplers}],
        "extensionsUsed": ["VRMC_vrm_animation"],
        "extensions": {"VRMC_vrm_animation": {
            "specVersion": "1.0",
            "humanoid": {"humanBones": human_bones},
        }},
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    glb = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + 8 + len(bin_data))
    glb += struct.pack("<II", len(js), 0x4E4F534A) + js
    glb += struct.pack("<II", len(bin_data), 0x004E4942) + bin_data
    with open(out_path, "wb") as f:
        f.write(glb)
    print(f"  → {out_path}  frames={n_frames} dur={t1-t0:.2f}s size={len(glb)//1024}KB")

# ---------- 入口 ----------
env = UnityPy.load(os.path.join(APP, "sharedassets0.assets"))
avatar_tt = None
for o in env.objects:
    if o.type.name == "Avatar":
        avatar_tt = o.read_typetree()
av = HumanAvatar(avatar_tt)
print("Avatar 骨數:", len(av.nodes), "human 對應:", len(av.bone_node))

os.makedirs(OUTDIR, exist_ok=True)
done = 0
for o in env.objects:
    if o.type.name != "AnimationClip": continue
    tt_clip = o.read_typetree()
    name = tt_clip["m_Name"]
    if ONLY is not None and name not in ONLY: continue
    if ONLY is None:
        mc = unwrap(tt_clip["m_MuscleClip"])
        binds = tt_clip["m_ClipBindingConstant"]["genericBindings"]
        humanoid = any(b["typeID"] == 95 and b["path"] == 0 for b in binds)
        if not humanoid or name.startswith("proxy_"): continue
    print(name)
    try:
        convert_clip(tt_clip, av, os.path.join(OUTDIR, name + ".vrma"))
        done += 1
    except Exception as e:
        import traceback; traceback.print_exc()
print("完成", done, "個")
