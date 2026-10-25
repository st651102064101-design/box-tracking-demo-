# Longitudinal simulation racks and building visibility

The user approved rotating the six simulation racks 90 degrees so their long axes run parallel to Gate In / Gate Out traffic. Preserve three back-to-back pairs, 18cm rear spacers, five shelves and five bays per rack, two pallets per bay, the initial five full racks / one empty rack, and the three existing vehicle roles and loop. Simulation remains memory-only and never writes business data.

Use 5.6m clear aisles between pairs: enough for two 1.4m-wide forklifts plus passing/steering clearance. All pairs share a longitudinal centre and slots advance away from the front gates. Vehicle docking and pedestrian collision detection must use the same rotated rack coordinates as the graphics. Route vehicles through a front cross-aisle without crossing rack footprints; reserve rack 1 until putaway has cleared it.

The chosen approach gives racks an explicit rotation and a shared local-to-world coordinate helper. This keeps graphics, pallets and docking aligned. Rotating only the mesh would leave cargo and routes in their old positions; rotating the entire scene would move gates, which the user explicitly wants preserved.

Use B to toggle the building shell (walls, roof and overhead structure). Keep floor, racks, boxes, gates and trucks visible. Allow an elevated orbit view while the shell is hidden. The toggle applies only to the current simulation session. H toggles all overlays; remove the Hide UI button, leaving only Orbit and First person buttons. Explain B/H in transient help and the canvas accessibility label, without adding a building button. Existing F, Ctrl, movement and Esc controls keep their behavior.

Authorization: the user's six-point scope and follow-up explicitly choosing 90 degrees. B and the exact 5.6m clearance are implementation choices. Rebuild the frontend Docker service and push scoped changes to WEB_APP_DEMO under the user's existing deployment/push instruction.
