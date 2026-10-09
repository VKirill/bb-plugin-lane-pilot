# office-people.glb

Eight chibi office workers for the council office scene (about 1.4 m tall, big head, flat cartoon colours), rigged and animated.
Made from concept images (Gemini, chibi style of the reference) -> Meshy image-to-3D with auto-rigging -> baked low-poly -> Universal Animation Library actions retargeted in Blender 5.2 -> glTF.

## Contents

- 1.34 MB, one GLB. Needs `KHR_mesh_quantization` (plain `GLTFLoader` supports it; no Meshopt/Draco decoder needed).
- 8 roots `char_0` .. `char_7` (Object3D at scene level). Each root has a child `char_N_body` (SkinnedMesh) and the bone chain starting at `Hips`.
- Same 22 bone names in every character: Hips, Spine02, Spine01, Spine, neck, Head, Left/RightShoulder, Left/RightArm, Left/RightForeArm, Left/RightHand, Left/RightUpLeg, Left/RightLeg, Left/RightFoot, Left/RightToeBase. No fingers. All bones have the same (identity) rest rotation in every character, so the clips below are interchangeable.
- One material per character (`char_N_mat`): base colour texture 512x512 JPEG, roughness 1, metalness 0, back-face culled.
- Each mesh is 2999-3000 triangles (2640-3199 vertices). Height 1.40 m, feet on y=0, origin between the feet, facing +Z, all roots at the origin.

| id | look |
|---|---|
| char_0 | owner: man, short dark hair, navy jacket, red sweater, white collar |
| char_1 | woman, long dark hair, lavender sweater, white collar |
| char_2 | woman, blond shoulder-length hair, blue sweater |
| char_3 | man, dark curly hair, darker skin, orange sweater |
| char_4 | man, brown hair, green sweater, grey trousers |
| char_5 | receptionist: red hair in a bun, white blouse, dark skirt |
| char_6 | man, glasses and short beard, teal shirt and tie |
| char_7 | woman, short black bob, yellow hoodie |

## Clips (24 fps, first key == last key, in place, no root motion)

| clip | seconds | what |
|---|---|---|
| Idle | 2.50 | standing idle (UAL Idle_Loop) |
| Walk | 1.33 | calm walk, in place (UAL Walk_Formal_Loop); one cycle = 2 steps |
| Talk | 2.92 | standing, talking with hands |
| Sit | 1.67 | seated idle, hands on the knees |
| SitTalk | 2.92 | seated talking |
| Interact | 2.00 | standing, one hand reaches forward and presses (printer, server) |
| SitType | 3.00 | seated typing: forearms forward, alternating hand motion, head slightly down (hands at pelvis + 0.17 m, 0.32 m in front of the pelvis) |
| Drink | 3.00 | standing, right hand brings a cup to the mouth and back (attach the cup to `RightHand`) |
| Point | 2.50 | standing, right arm points forward, two emphasis jabs |
| Window | 2.50 | standing, hands behind the back, idle sway |

All clips have 23 tracks: quaternion on all 22 bones plus `Hips` translation (only the Hips move).
The clips are stored once, on the `char_0` skeleton.

## Using it in three.js

`GLTFLoader` makes node names unique across the file, so bones of `char_1`..`char_7` load as `Hips_1`, `Spine_2`, ... The clips address the plain names. Restore them right after loading:

```js
gltf.scene.traverse(o => { if (o.isBone && o.userData.name) o.name = o.userData.name; });
const mixer = new THREE.AnimationMixer(charRoot);          // charRoot = gltf.scene.getObjectByName('char_3')
mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, 'SitType')).play();
```

Checked in three 0.186: all 23 tracks of every clip bind on every character after the rename; clips play on all 8.
For several copies of one character use `SkeletonUtils.clone`. Set `frustumCulled = false` on the SkinnedMeshes if culling pops (quantized positions).

## Sitting (the chairs in the scene have seat height 0.52)

In `Sit`, `SitTalk` and `SitType` the pelvis drops by 0.185 m and moves 0.17-0.21 m behind the feet (toward -Z), the feet stay on the floor, the thighs are horizontal. Numbers in glTF units (y up), the character at the origin, per character:

| id | Hips bone y (standing) | Hips bone y (seated) | Hips z (seated) | lowest point of seat/thigh mesh y (seat contact) |
|---|---|---|---|---|
| char_0 | 0.484 | 0.299 | -0.179 | 0.104 |
| char_1 | 0.517 | 0.332 | -0.213 | 0.188 |
| char_2 | 0.508 | 0.323 | -0.172 | 0.173 |
| char_3 | 0.526 | 0.341 | -0.170 | 0.174 |
| char_4 | 0.505 | 0.320 | -0.185 | 0.159 |
| char_5 | 0.608 | 0.423 | -0.165 | 0.187 |
| char_6 | 0.532 | 0.347 | -0.185 | 0.171 |
| char_7 | 0.441 | 0.256 | -0.185 | 0.114 |

The seat contact is only about 0.10-0.19 m, because chibi legs are short (hip joint 0.45 m above the floor). Put the character on a chair with: `char.position.y = seatHeight - contact`, and `char.position.z += 0.18` along its facing, so the pelvis sits over the seat centre.
With a 0.52 m seat that is `y = +0.33 .. +0.42` (about +0.36 on average) and the feet then hang about 0.35 m above the floor (the legs still swing freely, which looks like a child on a high chair). To keep the feet on the floor use a seat of about 0.17 m for these characters, or scale the characters up.
