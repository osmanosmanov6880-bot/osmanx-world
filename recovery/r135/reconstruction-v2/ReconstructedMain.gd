extends "res://StandaloneMain.gd"
## Reconstruction: integrates the separately recovered R136 cell into R135.
## This is a simulated demo, not the original complete R136 project.
var cell: Node3D
var facility: Node3D

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
    hud.text += "\nR136 CELL | RECONSTRUCTION | SIMULATION"

func _cell_view() -> void:
    focus = Vector3(0, 2.0, 9.2)
    distance = 15.0
    _update_view()

func _cell_stop() -> void:
    cell.emergency_stop()

func _cell_resume() -> void:
    cell.reset_emergency_stop()
    cell.set_motion(true)

func _toggle_rack_power() -> void:
    facility.set_power(not facility.power_on)

func _toggle_quality() -> void:
    super._toggle_quality()
    if cell:
        cell.set_quality(quality)

func _toggle_motion() -> void:
    super._toggle_motion()
    if cell:
        cell.set_motion(motion)
