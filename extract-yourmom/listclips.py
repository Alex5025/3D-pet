import UnityPy, sys
env = UnityPy.load(*sys.argv[1:])
names = []
for o in env.objects:
    if o.type.name == "AnimationClip":
        tt = o.read_typetree()
        mc = tt.get("m_MuscleClip") or {}
        binds = (tt.get("m_ClipBindingConstant") or {}).get("genericBindings") or []
        humanoid = any(b.get("path")==0 and (b.get("attribute") or 0) < 200 for b in binds)
        names.append((tt.get("m_Name"), len(binds), "HUMANOID" if humanoid else "generic", round(mc.get("m_StopTime",0),2)))
for n in sorted(names):
    print(n)
print("total", len(names))
