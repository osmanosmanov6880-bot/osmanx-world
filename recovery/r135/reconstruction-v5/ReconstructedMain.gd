extends "res://StandaloneMain.gd"
## Reconstruction: integrates the separately recovered R136 cell into R135.
## This is a simulated demo, not the original complete R136 project.
var cell: Node3D
var facility: Node3D
var engineering_status: Label
var diagnostic_status: Label
var diagnostics = preload("res://ReconstructedDiagnostics.gd").new()
var service = preload("res://ReconstructedServiceWorkflow.gd").new()
var service_status: Label

func _ready() -> void:
    super._ready()
    cell = preload("res://ReconstructedR136CellDirector.gd").new()
    cell.name = "RecoveredR136Cell"
    add_child(cell)
    var env := get_viewport().world_3d.environment
    cell.configure(camera, env)
    cell.set_quality(quality)
    facility = preload("res://ReconstructedFacility.gd").new()
    facility.name = "RECONSTRUCTED_FACILITY"
    add_child(facility)
    var controls := CanvasLayer.new()
    add_child(controls)
    var box := HBoxContainer.new()
    box.position = Vector2(18, 130)
    controls.add_child(box)
    _button(box, "R136 VIEW", _cell_view)
    _button(box, "SIM E-STOP", _cell_stop)
    _button(box, "RESET / PLAY", _cell_resume)
    _button(box, "RACK POWER", _toggle_rack_power)
    _button(box, "COOLING", _toggle_cooling)
    _button(box, "DEMO FILTER", _toggle_demo_filter)
    _button(box, "DEMO SENSOR", _toggle_demo_sensor)
    engineering_status = Label.new()
    engineering_status.position = Vector2(18, 176)
    controls.add_child(engineering_status)
    diagnostic_status = Label.new()
    diagnostic_status.position = Vector2(18, 205)
    controls.add_child(diagnostic_status)
    var service_box := HBoxContainer.new()
    service_box.position = Vector2(18, 275)
    controls.add_child(service_box)
    _button(service_box, "SERVICE PAUSE", func(): _service_action("pause"))
    _button(service_box, "OPEN", func(): _service_action("open"))
    _button(service_box, "INSPECT", func(): _service_action("inspect"))
    _button(service_box, "CLOSE", func(): _service_action("close"))
    _button(service_box, "RESUME", func(): _service_action("resume"))
    service_status = Label.new()
    service_status.position = Vector2(18, 315)
    controls.add_child(service_status)
    _refresh_service_status()
    hud.text += "\nR136 CELL | RECONSTRUCTION | SIMULATION"

func _process(_delta: float) -> void:
    if engineering_status and facility:
        var s: Dictionary = facility.summary()
        engineering_status.text = "SIMULATED | air %.1f C | rack %s | cooling %s | stop %s" % [s.air_temperature, "ON" if s.power_on else "OFF", "ON" if s.cooling_enabled else "OFF", "LATCHED" if s.emergency_latched else "CLEAR"]
        var assessment: Dictionary = diagnostics.assess(s)
        if not assessment.temperature_valid:
            engineering_status.text = "SIMULATED | air UNKNOWN | rack %s | cooling %s | stop %s" % ["ON" if s.power_on else "OFF", "ON" if s.cooling_enabled else "OFF", "LATCHED" if s.emergency_latched else "CLEAR"]
        diagnostic_status.text = "SIMULATED DIAGNOSTICS | %s\n%s" % [assessment.severity, "\n".join(assessment.notes)]

func _cell_view() -> void:
    focus = Vector3(0, 2.0, 9.2)
    distance = 15.0
    _update_view()

func _cell_stop() -> void:
    cell.emergency_stop()
    facility.emergency_stop()
    controller.set_motion(false)
    motion = false
    service.cancel()
    _refresh_service_status()

func _cell_resume() -> void:
    cell.reset_emergency_stop()
    facility.reset_emergency()
    # Reset clears latches only. It must not restart motion while hatch is open.
    if service.stage == "IDLE" and controller.lid_progress <= 0.01 and controller.lid_target <= 0.01:
        cell.set_motion(true)
        controller.set_motion(true)
        motion = true
    _refresh_service_status()

func _service_action(action: String) -> void:
    var ok: bool = service.request(action, controller, facility.emergency_latched)
    if ok and action == "pause":
        motion = false
        cell.set_motion(false)
    elif ok and action == "resume":
        motion = true
        cell.set_motion(true)
    _refresh_service_status()
    _refresh_status()

func _refresh_service_status() -> void:
    if service_status:
        service_status.text = "SIMULATED SERVICE | %s | %s" % [service.stage, service.note]

func _toggle_hatch() -> void:
    if facility and (facility.emergency_latched or service.stage != "IDLE"):
        return
    if controller.motion_enabled:
        return
    super._toggle_hatch()

func _toggle_rack_power() -> void:
    facility.set_power(not facility.power_on)

func _toggle_cooling() -> void:
    facility.set_cooling(not facility.cooling_enabled)

func _toggle_demo_filter() -> void:
    diagnostics.set_filter_fault(not diagnostics.demo_filter_blocked)

func _toggle_demo_sensor() -> void:
    diagnostics.set_sensor_fault(not diagnostics.simulated_sensor_failed)

func _toggle_quality() -> void:
    super._toggle_quality()
    if cell:
        cell.set_quality(quality)

func _toggle_motion() -> void:
    if facility and facility.emergency_latched:
        return
    if service.stage != "IDLE":
        return
    if not motion and (controller.lid_progress > 0.01 or controller.lid_target > 0.01):
        return
    super._toggle_motion()
    if cell:
        cell.set_motion(motion)
