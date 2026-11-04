extends SceneTree

func _initialize() -> void:
    call_deferred("run_check")

func run_check() -> void:
    var scene: Node = load("res://ReconstructedMain.tscn").instantiate()
    root.add_child(scene)
    await process_frame
    assert(scene.facility.summary().rack_count == 8)
    assert(scene.facility.summary().power_on)
    scene._toggle_rack_power()
    assert(not scene.facility.summary().power_on)
    scene._toggle_rack_power()
    assert(scene.facility.summary().power_on)
    var cell = scene.cell
    var first: Dictionary = cell.summary()
    assert(first.missing_animated_nodes == 0)
    assert(first.lod == 0)
    scene._cell_stop()
    assert(cell.summary().estop_latched)
    scene._cell_resume()
    assert(not cell.summary().estop_latched)
    assert(cell.summary().motion_enabled)
    scene._toggle_quality()
    assert(cell.summary().lod == 1)
    assert(cell.summary().missing_animated_nodes == 0)
    scene._cell_view()
    assert(scene.focus == Vector3(0, 2.0, 9.2))
    print("RECONSTRUCTION_SMOKE_PASS")
    quit(0)
