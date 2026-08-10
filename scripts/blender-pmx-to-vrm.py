import bpy, addon_utils
addon_utils.enable('bl_ext.blender_org.mmd_tools', default_set=True, persistent=True)
addon_utils.enable('bl_ext.blender_org.vrm', default_set=True, persistent=True)
bpy.ops.wm.open_mainfile(filepath='/tmp/yae_pmx.blend')
arm = bpy.data.objects['yae_arm']
bpy.context.view_layer.objects.active = arm
arm.select_set(True)

ext = arm.data.vrm_addon_extension
ext.spec_version = '0.0'
print('T_POSE_OPS', [o for o in dir(bpy.ops.vrm) if 'pose' in o or 'tpose' in o.lower()])

MAP = {
  'hips': '腰', 'spine': '上半身', 'chest': '上半身2', 'neck': '首', 'head': '頭',
  'leftShoulder': '肩.L', 'leftUpperArm': '腕.L', 'leftLowerArm': 'ひじ.L', 'leftHand': '手首.L',
  'rightShoulder': '肩.R', 'rightUpperArm': '腕.R', 'rightLowerArm': 'ひじ.R', 'rightHand': '手首.R',
  'leftUpperLeg': '足.L', 'leftLowerLeg': 'ひざ.L', 'leftFoot': '足首.L', 'leftToes': 'つま先.L',
  'rightUpperLeg': '足.R', 'rightLowerLeg': 'ひざ.R', 'rightFoot': '足首.R', 'rightToes': 'つま先.R',
}
FW = {'0': '０', '1': '１', '2': '２', '3': '３'}
for key, jp in [('Thumb','親指'), ('Index','人指'), ('Middle','中指'), ('Ring','薬指'), ('Little','小指')]:
    idx = ['0','1','2'] if key == 'Thumb' else ['1','2','3']
    for i, part in zip(idx, ['Proximal','Intermediate','Distal']):
        for s, side in (('L','left'), ('R','right')):
            MAP[f'{side}{key}{part}'] = f'{jp}{FW[i]}.{s}'

hum = ext.vrm0.humanoid
print('HB_TYPE', type(hum.human_bones), 'LEN', len(hum.human_bones))
existing = {hb.bone: hb for hb in hum.human_bones}
print('EXISTING_KEYS', list(existing)[:8])
ok = 0
for bone, node in MAP.items():
    hb = existing.get(bone)
    if hb is None:
        hb = hum.human_bones.add(); hb.bone = bone
    hb.node.bone_name = node
    if hb.node.bone_name == node: ok += 1
print('ASSIGNED', ok, '/', len(MAP))
print('ERRORS', hum.all_required_bones_are_assigned() if hasattr(hum, 'all_required_bones_are_assigned') else 'n/a')
bpy.ops.export_scene.vrm(filepath='/tmp/yaepmx/yae_raw.vrm')
print('EXPORT OK')
