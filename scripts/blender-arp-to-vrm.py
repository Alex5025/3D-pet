import bpy, addon_utils
addon_utils.enable('bl_ext.blender_org.vrm', default_set=True, persistent=True)

# 0. 剔除未綁骨架的殘留參考模型(棕髮女孩)
for name in ('Body', 'Face'):
    o = bpy.data.objects.get(name)
    if o:
        bpy.data.objects.remove(o, do_unlink=True)
        print('REMOVED', name)

arm = bpy.data.objects['rig']
bpy.context.view_layer.objects.active = arm

# 1. 重建人形父子鏈
REPARENT = {
  'root.x': None,
  'spine_01.x': 'root.x', 'spine_02.x': 'spine_01.x', 'spine_03.x': 'spine_02.x',
  'neck.x': 'spine_03.x', 'head.x': 'neck.x',
  'shoulder.l': 'spine_03.x', 'shoulder.r': 'spine_03.x',
  'arm_stretch.l': 'shoulder.l', 'arm_stretch.r': 'shoulder.r',
  'forearm_stretch.l': 'arm_stretch.l', 'forearm_stretch.r': 'arm_stretch.r',
  'forearm.l': 'forearm_stretch.l', 'forearm.r': 'forearm_stretch.r',
  'thigh_stretch.l': 'root.x', 'thigh_stretch.r': 'root.x',
  'leg_stretch.l': 'thigh_stretch.l', 'leg_stretch.r': 'thigh_stretch.r',
  'foot.l': 'leg_stretch.l', 'foot.r': 'leg_stretch.r',
  'thigh_twist.l': 'thigh_stretch.l', 'thigh_twist.r': 'thigh_stretch.r',
  'c_arm_twist_offset.l': 'arm_stretch.l', 'c_arm_twist_offset.r': 'arm_stretch.r',
}
bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones
for b in list(eb):
    if b.parent and b.parent.name == 'c_head.x' and b.name != 'head.x':
        b.parent = eb['head.x']
for name, parent in REPARENT.items():
    if name in eb:
        eb[name].use_connect = False
        eb[name].parent = eb[parent] if parent else None
for side in ('l', 'r'):
    t, f = f'toes_01.{side}', f'foot.{side}'
    if t in eb and f in eb: eb[t].use_connect = False; eb[t].parent = eb[f]
bpy.ops.object.mode_set(mode='OBJECT')

# 2. 人形骨指派
ext = arm.data.vrm_addon_extension
ext.spec_version = '1.0'
hb = ext.vrm1.humanoid.human_bones
MAP = {
  'hips': 'root.x', 'spine': 'spine_01.x', 'chest': 'spine_02.x', 'upper_chest': 'spine_03.x',
  'neck': 'neck.x', 'head': 'head.x',
  'left_shoulder': 'shoulder.l', 'left_upper_arm': 'arm_stretch.l', 'left_lower_arm': 'forearm_stretch.l', 'left_hand': 'hand.l',
  'right_shoulder': 'shoulder.r', 'right_upper_arm': 'arm_stretch.r', 'right_lower_arm': 'forearm_stretch.r', 'right_hand': 'hand.r',
  'left_upper_leg': 'thigh_stretch.l', 'left_lower_leg': 'leg_stretch.l', 'left_foot': 'foot.l', 'left_toes': 'toes_01.l',
  'right_upper_leg': 'thigh_stretch.r', 'right_lower_leg': 'leg_stretch.r', 'right_foot': 'foot.r', 'right_toes': 'toes_01.r',
}
for bone, name in MAP.items():
    getattr(hb, bone).node.bone_name = name
print('HUMANOID_ERRORS', hb.error_messages() if callable(getattr(hb, 'error_messages', None)) else 'n/a')

# 3. 表情:從 ARKit shape key 自動建 VRM1 expressions
try:
    props = bpy.ops.vrm.assign_vrm1_expressions_from_arkit.get_rna_type().properties.keys()
    print('ARKIT_PROPS', list(props))
    bpy.ops.vrm.assign_vrm1_expressions_from_arkit(armature_object_name='rig')
    print('ARKIT OK')
except Exception as e:
    print('ARKIT FAIL', e)
    try:
        bpy.ops.vrm.assign_vrm1_expressions_automatically(armature_object_name='rig')
        print('AUTO_EXPR OK')
    except Exception as e2:
        print('AUTO_EXPR FAIL', e2)

bpy.ops.export_scene.vrm(filepath='/tmp/renai/RenAi.vrm')
print('EXPORT OK')
