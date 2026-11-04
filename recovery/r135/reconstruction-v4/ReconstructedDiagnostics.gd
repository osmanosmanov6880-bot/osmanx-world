extends RefCounted
## New simulated diagnostic logic; no live telemetry or physical controls.
var demo_filter_blocked := false
var simulated_sensor_failed := false
var events: Array[String] = []

func set_filter_fault(enabled: bool) -> void:
    demo_filter_blocked = enabled
    events.append("SIM: filter fault " + ("ON" if enabled else "OFF"))
    if events.size() > 12:
        events.pop_front()

func set_sensor_fault(enabled: bool) -> void:
    simulated_sensor_failed = enabled
    events.append("SIM: sensor fault " + ("ON" if enabled else "OFF"))
    if events.size() > 12:
        events.pop_front()

func assess(state: Dictionary) -> Dictionary:
    var notes: Array[String] = []
    var severity := "NORMAL"
    if bool(state.get("emergency_latched", false)):
        severity = "STOPPED"
        notes.append("Emergency stop latched. Clear latch before simulated restart.")
    if simulated_sensor_failed:
        if severity != "STOPPED":
            severity = "SENSOR UNKNOWN"
        notes.append("Simulated sensor unavailable; temperature is not displayed.")
    if demo_filter_blocked:
        if severity == "NORMAL":
            severity = "ATTENTION"
        notes.append("Simulated filter restriction. Inspect filter before simulated reset.")
    if not bool(state.get("cooling_enabled", false)):
        if severity == "NORMAL":
            severity = "ATTENTION"
        notes.append("Cooling is off.")
    if notes.is_empty():
        notes.append("No simulated fault flags.")
    return {"severity": severity, "notes": notes, "temperature_valid": not simulated_sensor_failed, "simulation": true}
