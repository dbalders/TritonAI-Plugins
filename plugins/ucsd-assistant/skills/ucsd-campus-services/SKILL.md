---
name: ucsd-campus-services
description: Use direct public UC San Diego campus tools for places, maps, and live campus information, and distinguish current service readings from published guidance.
---

# UCSD campus services

Use `ucsd.list_services` to see verified service routes and their limits. It is an inventory, not a live health check. These tools call the public APIs used by campus websites directly; the separate campus gateway MCPs require authentication and are not used.

For places and maps:

- Resolve building names with `ucsd.search_map_buildings` and named places with `ucsd.search_map_pois`. Use returned longitude/latitude rather than guessing. If a name is ambiguous, select the relevant result or ask the user.
- Discover exact category values with `ucsd.list_map_poi_classes`. Use those values for the `class` filter on POI search or `ucsd.nearby_map_pois`. Nearby results are a bounded service-ordered sample, not guaranteed nearest-first.
- `ucsd.map_distance` computes direct geodesic distance in explicitly selected meters or feet. It is not a walking distance.
- Use `ucsd.map_walking_route` with `mode: "walking"` or `mode: "ada"` for the service's modeled route, feet, walking minutes and directions. The ADA option uses the service's actual travel mode. Preserve solver warnings and any stop relocation. Report the network build date when relevant; this is not live closure detection or confirmation of current field accessibility.

For busyness, call `ucsd.get_campus_busyness`, optionally filtering a location name such as `Geisel`. It includes reported floor detail, percentages, estimated people, capacity and open/unavailable flags. Its source measurement time is unknown. Describe the result as retrieved at the returned time; neither retrieval time nor HTTP Date proves measurement freshness. Closed locations may retain estimates; unavailable locations have no usable occupancy reading. Do not infer parking occupancy from this feed.

Anonymous live parking availability is not verified. Use the Transportation site linked by `ucsd.list_services` for dated surveys, permit guidance and published parking information. Clearly label surveys as historical, and do not infer current free spaces from map inventory or the surveys.

Use the relevant direct tool when a question concerns a supported service reading or route. Preserve source timestamps, estimate labels and units. The time a tool ran is not necessarily when a reading was measured. Do not substitute a dated webpage or model knowledge for a current service reading.

For a place or building, resolve its name and coordinates through the available campus tool or the official public map at https://campusmap.ucsd.edu/. Ask which campus or location when necessary. Distinguish straight-line distance from a walking route. Request the service's accessible-route option when the user asks for ADA/accessibility routing; do not infer an accessible route from distance alone.

When a service is unavailable or needs authorization, state that it was not queried. Offer its official public website or supported alternative. This plugin's public-source features work without signing in. Do not extract an API token from Onyx, borrow another plugin's credentials, or change campus service settings to make a call work.

For published policy, procedures, opening hours, eligibility, permits or other explanatory information, use `ucsd-campus-search` to read and cite the responsible campus source. Distinguish that guidance from any live measurement.
