import UnityPy, sys, collections
path = sys.argv[1]
env = UnityPy.load(path)
counts = collections.Counter()
named = []
for obj in env.objects:
    counts[obj.type.name] += 1
    if obj.type.name in ("TextAsset","AnimationClip","GameObject","MonoBehaviour","Mesh","AssetBundle","Animator","Avatar"):
        try:
            d = obj.read()
            name = getattr(d, "m_Name", "") or ""
            if name:
                named.append((obj.type.name, name, obj.path_id))
        except Exception as e:
            named.append((obj.type.name, f"<err {e}>", obj.path_id))
print(counts)
for t, n, p in named[:80]:
    print(t, "|", n, "|", p)
