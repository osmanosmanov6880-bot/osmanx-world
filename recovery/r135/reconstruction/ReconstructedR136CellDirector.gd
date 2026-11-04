# RECONSTRUCTED: corrected loop syntax to run in Godot. Original in originals/.
extends Node3D
## R136 Precision Inspection Cell. Entirely simulated, physically bounded visual study.
## Movable pieces are real mesh nodes imported from GLB, not overlay sprites.
## No remote commands, PLC control, real monitoring or production operations.
const ECO: String = "res://models/r136/r136_precision_cell_eco.glb"
const HERO: String = "res://models/r136/r136_precision_cell_hero.glb"
const MOVERS: Array[String] = ["R136_TROLLEY", "R136_HEAD", "R136_JAW_LEFT", "R136_JAW_RIGHT", "R136_DRAWER_A", "R136_DRAWER_B", "R136_DRAWER_C", "R136_INTERLOCK_DOOR", "R136_INTERLOCK_DOOR_FRAME"]
const CYCLE_SECONDS: float = 20.0
var model_root: Node3D
var mover_nodes: Dictionary = {}
var base_positions: Dictionary = {}
var current_lod: int = -1
var load_count: int = 0
var missing_nodes: int = 0
var motion_enabled: bool = true
var emergency_stop_latched: bool = false
var phase: float = 0.0
var details: Dictionary = {}
var practical_lights: Array[SpotLight3D] = []
var cell_camera: Camera3D
var world: Environment

func configure(cam: Camera3D, e: Environment) -> void:
    cell_camera = cam
    world = e
    for i in range(4):
        var light := SpotLight3D.new()
        light.name = "R136_Simulated_Inspection_Light_%d" % i
        light.position = Vector3(-3.6+float(i)*2.4,4.30,9.2)
        light.rotation_degrees = Vector3(-90.0,0.0,0.0)
        light.spot_range = 5.8
        light.spot_angle = 42.0
        light.light_color = Color(.82,.91,1.0) if i%2 else Color(1.0,.84,.71)
        light.light_energy = .85
        light.shadow_enabled = false
        add_child(light)
        practical_lights.append(light)

static func eased(t: float) -> float:
    var x: float = clampf(t,0.0,1.0)
    return x*x*(3.0-2.0*x)

static func state_at(seconds: float) -> Dictionary:
    # 0-2 unlock/open; 2-6 translate; 6-9 lower; 9-11 grip;
    # 11-12 release; 12-14 lift; 14-18 return; 18-20 close.
    var p: float = fposmod(seconds,CYCLE_SECONDS)
    var door: float = eased(p/2.0)*(1.0-eased((p-18.0)/2.0))
    var trolley: float = eased((p-2.0)/4.0)*(1.0-eased((p-14.0)/4.0))
    var head: float = eased((p-6.0)/3.0)*(1.0-eased((p-12.0)/2.0))
    var gripper: float = eased((p-9.0)/2.0)*(1.0-eased((p-11.0)/1.0))
    var drawers: float = eased((p-4.0)/2.0)*(1.0-eased((p-15.0)/2.0))
    # Mechanical interlock: no travel while the access door is closing.
    if door < .999:
        trolley = minf(trolley,door)
    return {"seconds":p,"door":door,"trolley":trolley,"head":head,"grip":gripper,"drawers":drawers}

func set_quality(q: int) -> void:
    var lod: int = 0 if q==0 else 1
    if current_lod != lod:
        _swap_resource(ECO if lod==0 else HERO,lod)
    for i in range(practical_lights.size()):
        practical_lights[i].visible = q>=1 or i%2==0
        practical_lights[i].shadow_enabled = q==2 and i==1

func _swap_resource(path: String, next_lod: int) -> void:
    var resource: Resource = load(path)
    if not (resource is PackedScene):
        push_error("R136 model load failed, keeping previous model: "+path)
        return
    var loaded: Node3D = (resource as PackedScene).instantiate() as Node3D
    if loaded == null:
        push_error("R136 GLB has no 3D root: "+path)
        return
    loaded.name = "R136_PRECISION_CELL_VISUAL_SIMULATION"
    add_child(loaded)
    var old: Node3D = model_root
    model_root = loaded
    current_lod = next_lod
    load_count += 1
    mover_nodes.clear()
    base_positions.clear()
    missing_nodes = 0
    for key in MOVERS:
        var found: Node = loaded.find_child(key,true,false)
        if found is Node3D:
            mover_nodes[key]=found
            base_positions[key]=(found as Node3D).position
        else:
            missing_nodes += 1
            push_warning("R136 animated node missing: "+key)
    _pose(state_at(phase))
    if old != null:
        old.queue_free()

func _set_pos(key: String, offset: Vector3) -> void:
    if mover_nodes.has(key):
        var part: Node3D = mover_nodes[key]
        part.position = (base_positions[key] as Vector3)+offset

func _pose(s: Dictionary) -> void:
    var dx: float = -2.75+5.50*float(s["trolley"])
    # All moving meshes share a documented origin-independent translation.
    _set_pos("R136_TROLLEY",Vector3(dx,0,0))
    _set_pos("R136_HEAD",Vector3(dx,-.58*float(s["head"]),0))
    _set_pos("R136_JAW_LEFT",Vector3(dx+.062*float(s["grip"]),-.58*float(s["head"]),0))
    _set_pos("R136_JAW_RIGHT",Vector3(dx-.062*float(s["grip"]),-.58*float(s["head"]),0))
    for item in ["R136_DRAWER_A","R136_DRAWER_B","R136_DRAWER_C"]:
        _set_pos(item,Vector3(0,0,.52*float(s["drawers"])))
    _set_pos("R136_INTERLOCK_DOOR",Vector3(-2.35*float(s["door"]),0,0))
    _set_pos("R136_INTERLOCK_DOOR_FRAME",Vector3(-2.35*float(s["door"]),0,0))
    details = s

func _physics_process(delta: float) -> void:
    if not motion_enabled or emergency_stop_latched:
        return
    # Fixed physics ticks; phase is absolute, not accumulated transform error.
    phase = fposmod(phase+maxf(0.0,delta),CYCLE_SECONDS)
    _pose(state_at(phase))

func set_motion(active: bool) -> void:
    motion_enabled = active

func emergency_stop() -> void:
    emergency_stop_latched = true
    # Freeze in place; don't teleport moving mechanisms during E-stop.

func reset_emergency_stop() -> void:
    # A deliberate local operator action, never automatic restart.
    emergency_stop_latched = false
    motion_enabled = false

func inspect_cell() -> void:
    if cell_camera == null:
        return

func summary() -> Dictionary:
    return {"schema":"OSGARD_R136_SIMULATED_CELL_V1", "simulation_only":true,
        "real_hardware_connected":false,"physical_gpu_benchmarked":false,
        "lod":current_lod,"model_loads":load_count,"missing_animated_nodes":missing_nodes,
        "phase_seconds":phase,"motion_enabled":motion_enabled,
        "estop_latched":emergency_stop_latched,"state":details.duplicate(true)}
