import bpy, addon_utils
bpy.ops.wm.read_factory_settings(use_empty=True)
for ext in ('bl_ext.blender_org.mmd_tools', 'bl_ext.blender_org.vrm'):
    addon_utils.enable(ext, default_set=True, persistent=True)
path = "/tmp/yaepmx/yae.pmx"
bpy.ops.mmd_tools.import_model(filepath=path, types={'MESH','ARMATURE','MORPHS'}, scale=0.08, clean_model=True, log_level='ERROR')
print('IMPORT OK')
arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
print('ARMATURES', [(a.name, len(a.data.bones)) for a in arms])
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
print('MESHES', [(m.name, len(m.data.vertices)) for m in meshes][:6])
for m in meshes:
    if m.data.shape_keys:
        ks = [k.name for k in m.data.shape_keys.key_blocks]
        print('SHAPEKEYS', m.name, len(ks), ks[:25])
if arms:
    a = arms[0]
    names = [b.name for b in a.data.bones]
    print('BONES', len(names), names[:22])
    zs = [b.head_local.z for b in a.data.bones]
    print('HEIGHT_Z', round(min(zs),3), round(max(zs),3))
bpy.ops.wm.save_as_mainfile(filepath='/tmp/yae_pmx.blend')
print('SAVED')
