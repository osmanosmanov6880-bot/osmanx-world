extends Node3D
## Newly built environment: this does not represent recovered R131-R134 assets.
## Dimensions and equipment placement are an interpretation of the R135 brief.
var rack_count := 0
var power_on := true
var indicator_materials: Array[StandardMaterial3D] = []

func _material(color: Color, metal: float = 0.0, rough: float = 0.65) -> StandardMaterial3D:
    var m := StandardMaterial3D.new()
    m.albedo_color = color
    m.metallic = metal
    m.roughness = rough
    return m

func _box(parent: Node3D, label: String, position_: Vector3, size_: Vector3, material: Material) -> MeshInstance3D:
    var n := MeshInstance3D.new()
    n.name = label
    var mesh := BoxMesh.new()
    mesh.size = size_
    n.mesh = mesh
    n.material_override = material
    n.position = position_
    parent.add_child(n)
    return n

func _ready() -> void:
    var floor_mat := _material(Color(0.075, 0.105, 0.13), 0.5, 0.72)
    var steel := _material(Color(0.24, 0.3, 0.34), 0.75, 0.42)
    var dark := _material(Color(0.035, 0.053, 0.068), 0.5, 0.5)
    var panel := _material(Color(0.10, 0.15, 0.19), 0.6, 0.5)
    _box(self, "Floor", Vector3(0,-0.2,4), Vector3(22,0.3,30), floor_mat)
    _box(self, "WestWall", Vector3(-10.8,3.8,4), Vector3(0.3,8,30), panel)
    _box(self, "EastWall", Vector3(10.8,3.8,4), Vector3(0.3,8,30), panel)
    _box(self, "BackWall", Vector3(0,3.8,-10.8), Vector3(22,8,0.3), panel)
    for x in range(-10, 11, 2):
        _box(self,"FloorSeam",Vector3(x,0,4),Vector3(0.025,0.02,30),steel)
    for z in range(-10, 19, 2):
        _box(self,"FloorSeam",Vector3(0,0,z),Vector3(22,0.02,0.025),steel)
    for x in [-8.0, 8.0]:
        for z in [-6.0, -2.0, 2.0, 6.0]:
            _rack(Vector3(x,0,z), steel, dark, panel, x < 0)
    for x in [-7.0, 7.0]:
        _box(self,"CableTray",Vector3(x,5.8,3),Vector3(0.8,0.18,24),steel)
        for z in range(-8,16,2):
            _box(self,"TrayCrossbar",Vector3(x,5.9,z),Vector3(1.1,0.08,0.12),dark)
    for z in [-6.0, 2.0, 10.0]:
        var glow := _material(Color(0.45,0.75,0.88),0.2,0.35)
        glow.emission_enabled = true
        glow.emission = Color(0.12,0.55,0.8)
        glow.emission_energy_multiplier = 1.7
        _box(self,"CeilingLight",Vector3(0,7.1,z),Vector3(9,0.1,0.2),glow)
        var light := OmniLight3D.new()
        light.position = Vector3(0,6.7,z)
        light.light_color = Color(0.6,0.8,1.0)
        light.light_energy = 1.2
        light.omni_range = 11
        add_child(light)

func _rack(pos: Vector3, steel: Material, dark: Material, panel: Material, face_right: bool) -> void:
    var rack := Node3D.new()
    rack.name = "ReconstructedRack%02d" % rack_count
    rack_count += 1
    rack.position = pos
    add_child(rack)
    _box(rack,"Cabinet",Vector3(0,1.6,0),Vector3(1.2,3.2,1.6),dark)
    for y in range(0,8):
        _box(rack,"EquipmentTray",Vector3(0,0.28+y*0.38,0),Vector3(1.25,0.09,1.64),steel)
        var facing := 0.63 if face_right else -0.63
        _box(rack,"Faceplate",Vector3(facing,0.45+y*0.38,0),Vector3(0.035,0.24,1.42),panel)
        var ind := _material(Color(0.03,0.35,0.5),0.1,0.35)
        ind.emission_enabled = true
        ind.emission = Color(0.02,0.8,1.0)
        ind.emission_energy_multiplier = 1.3
        indicator_materials.append(ind)
        for z in [-0.48, -0.28, -0.08]:
            _box(rack,"StatusLED",Vector3(facing*1.04,0.45+y*0.38,z),Vector3(0.045,0.035,0.035),ind)

func set_power(enabled: bool) -> void:
    power_on = enabled
    for m in indicator_materials:
        m.emission_energy_multiplier = 1.3 if enabled else 0.0

func summary() -> Dictionary:
    return {"rack_count": rack_count, "power_on": power_on, "reconstructed": true}
