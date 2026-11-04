extends RefCounted
## New reconstruction: local, bounded simulation event journal; no hardware.
const MAX_EVENTS := 300
var records: Array[Dictionary] = []
var sequence := 0

func append_event(kind: String, detail: String, data: Dictionary = {}) -> void:
	sequence += 1
	if records.size() >= MAX_EVENTS:
		records.pop_front()
	records.append({"sequence": sequence, "utc": Time.get_datetime_string_from_system(true), "type": kind, "detail": detail, "data": data.duplicate(true)})

func snapshot() -> Dictionary:
	return {"schema": "OSGARD_RECONSTRUCTED_SIMULATION_EVENTS_V1", "simulation_only": true, "events": records.duplicate(true)}

func export_to(path: String) -> Error:
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		return FileAccess.get_open_error()
	file.store_string(JSON.stringify(snapshot(), "  "))
	file.close()
	return OK
