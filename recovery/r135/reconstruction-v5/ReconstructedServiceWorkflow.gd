extends RefCounted
## Reconstructed training sequence; no physical equipment is connected.
var stage := "IDLE"
var note := "Ready. Pause movement before opening the hatch."

func request(action: String, controller: Node, emergency: bool) -> bool:
    if emergency:
        note = "Emergency stop active; reset it before starting service."
        return false
    match action:
        "pause":
            if stage != "IDLE":
                return false
            controller.set_motion(false)
            stage = "PAUSED"
            note = "Motion paused. Open hatch."
        "open":
            if stage != "PAUSED" or controller.motion_enabled:
                note = "Pause motion before opening hatch."
                return false
            if controller.lid_target < 0.5:
                controller.toggle_access_lid()
            stage = "OPENING"
            note = "Opening hatch; wait for it to reach its end position."
        "inspect":
            if stage != "OPENING" or controller.lid_progress < 0.99 or controller.motion_enabled:
                note = "Inspection requires stopped motion and fully open hatch."
                return false
            stage = "INSPECTED"
            note = "Simulated inspection recorded. Close hatch."
        "close":
            if stage != "INSPECTED":
                note = "Record inspection before closing."
                return false
            if controller.lid_target > 0.5:
                controller.toggle_access_lid()
            stage = "CLOSING"
            note = "Closing hatch; wait for it to close."
        "resume":
            if stage != "CLOSING" or controller.lid_progress > 0.01:
                note = "Resume requires a fully closed hatch."
                return false
            controller.set_motion(true)
            stage = "IDLE"
            note = "Sequence complete. Motion resumed."
        _:
            return false
    return true

func cancel() -> void:
    stage = "IDLE"
    note = "Service sequence interrupted; verify hatch and motion before restart."
