const form = document.querySelector("#route-form");
const locateButton = document.querySelector("#locate-button");
const locationStatus = document.querySelector("#location-status");
const nearbySummary = document.querySelector("#nearby-summary");
const suggestionList = document.querySelector("#suggestion-list");
const startInput = document.querySelector("#start");
const destinationInput = document.querySelector("#destination");
const startSuggestions = document.querySelector("#start-suggestions");
const destinationSuggestions = document.querySelector("#destination-suggestions");
const routeMapElement = document.querySelector("#route-map");
const routeSteps = document.querySelector("#route-steps");
const routeSummary = document.querySelector("#route-summary");
const submitButton = form.querySelector('button[type="submit"]');

const nearbySearchRadiusMeters = 1800;
const overpassEndpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const locationStorageKey = "route-rehearsal:last-location";

let currentLocation = null;
let routeMap = null;
let routeLayer = null;
let routeMarkers = [];
const knownPlaces = new Map();

initializeRouteMap();
restoreSavedLocation();

locateButton.addEventListener("click", async () => {
  if (!navigator.geolocation) {
    locationStatus.textContent = "This browser does not support location.";
    return;
  }

  locationStatus.textContent = "Finding your location...";
  locateButton.disabled = true;

  try {
    const position = await getCurrentPosition();
    const { latitude, longitude } = position.coords;
    const fallbackLocationLabel = formatCoordinatesLabel(latitude, longitude);
    let locationLabel = fallbackLocationLabel;
    let nearbyPlaces = [];

    startInput.value = fallbackLocationLabel;
    locationStatus.textContent = "Location found. Looking for nearby places...";
    nearbySummary.textContent = "Checking your area for a few nearby destinations.";

    const [locationResult, nearbyPlacesResult] = await Promise.allSettled([
      getLocationLabel(latitude, longitude),
      getNearbyPlaces(latitude, longitude),
    ]);

    if (locationResult.status === "fulfilled") {
      locationLabel = locationResult.value;
    }

    if (nearbyPlacesResult.status === "fulfilled") {
      nearbyPlaces = nearbyPlacesResult.value;
    }

    currentLocation = {
      label: locationLabel,
      latitude,
      longitude,
    };
    saveLocation(currentLocation);

    fillSuggestions(locationLabel, nearbyPlaces);
    locationStatus.textContent = nearbyPlaces.length
      ? "Location found and nearby places loaded."
      : "Location found. Nearby place suggestions are limited right now.";
  } catch (error) {
    locationStatus.textContent = getLocationErrorMessage(error);
    nearbySummary.textContent =
      "Location was not available yet. You can still type places manually.";
  } finally {
    locateButton.disabled = false;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const start = formData.get("start")?.toString().trim();
  const destination = formData.get("destination")?.toString().trim();

  if (!start || !destination) {
    routeSummary.textContent = "Please enter both a start and a destination.";
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Building dry run...";
  routeSummary.textContent = "Finding the route and building your preview...";
  routeSteps.innerHTML = `
    <p class="placeholder-copy">
      Pulling together the map, drive summary, and key moments.
    </p>
  `;
  resetMapView();

  let startPlace = null;
  let destinationPlace = null;
  try {
    [startPlace, destinationPlace] = await Promise.all([
      resolvePlace(start),
      resolvePlace(destination),
    ]);
    const route = await getRoute(startPlace, destinationPlace);

    renderRoute(route, startPlace, destinationPlace);
  } catch (error) {
    if (startPlace && destinationPlace) {
      drawFallbackMap(startPlace, destinationPlace);
    }

    routeSummary.textContent =
      error.message ||
      "We could not build this route yet. Please try a slightly more specific place name.";
    routeSteps.innerHTML = `
      <p class="placeholder-copy">
        Try entering a fuller address or a nearby landmark and then run it again.
      </p>
    `;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Preview dry run";
  }
});

function getCurrentPosition() {
  return tryGetPosition({
    enableHighAccuracy: true,
    timeout: 7000,
    maximumAge: 120000,
  }).catch((error) => {
    if (error?.code === 1) {
      throw error;
    }

    return tryGetPosition({
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 600000,
    }).catch((secondError) => {
      const savedLocation = loadSavedLocation();

      if (savedLocation) {
        return {
          coords: {
            latitude: savedLocation.latitude,
            longitude: savedLocation.longitude,
          },
        };
      }

      throw secondError;
    });
  });
}

async function getLocationLabel(latitude, longitude) {
  const reverseUrl = new URL("https://nominatim.openstreetmap.org/reverse");

  reverseUrl.searchParams.set("format", "jsonv2");
  reverseUrl.searchParams.set("lat", latitude);
  reverseUrl.searchParams.set("lon", longitude);
  reverseUrl.searchParams.set("zoom", "18");

  const response = await fetch(reverseUrl);

  if (!response.ok) {
    throw new Error("Reverse geocoding failed.");
  }

  const data = await response.json();
  const address = data.address ?? {};
  const road = address.road || address.pedestrian || address.neighbourhood;
  const city =
    address.city || address.town || address.village || address.hamlet || "";

  if (road && city) {
    return `${road}, ${city}`;
  }

  return data.display_name || "My current location";
}

async function getNearbyPlaces(latitude, longitude) {
  const query = `
    [out:json][timeout:20];
    (
      node(around:${nearbySearchRadiusMeters},${latitude},${longitude})["amenity"]["name"];
      node(around:${nearbySearchRadiusMeters},${latitude},${longitude})["shop"]["name"];
      node(around:${nearbySearchRadiusMeters},${latitude},${longitude})["tourism"]["name"];
      node(around:${nearbySearchRadiusMeters},${latitude},${longitude})["leisure"]["name"];
      node(around:${nearbySearchRadiusMeters},${latitude},${longitude})["highway"="parking"]["name"];
    );
    out body;
  `.trim();

  let data = null;

  for (const endpoint of overpassEndpoints) {
    try {
      const url = new URL(endpoint);

      url.searchParams.set("data", query);

      const response = await fetch(url, {
        method: "GET",
      });

      if (!response.ok) {
        continue;
      }

      data = await response.json();
      break;
    } catch (error) {
      continue;
    }
  }

  if (!data) {
    return [];
  }

  return (data.elements ?? [])
    .map((place) => ({
      name: place.tags?.name,
      latitude: place.lat,
      longitude: place.lon,
      type:
        place.tags?.amenity ||
        place.tags?.shop ||
        place.tags?.tourism ||
        place.tags?.leisure ||
        "place",
      distance: calculateDistanceMeters(
        latitude,
        longitude,
        place.lat,
        place.lon,
      ),
    }))
    .filter((place) => place.name)
    .sort((a, b) => a.distance - b.distance)
    .filter(
      (place, index, places) =>
        places.findIndex(
          (otherPlace) =>
            otherPlace.name.toLowerCase() === place.name.toLowerCase(),
        ) === index,
    )
    .slice(0, 8);
}

function fillSuggestions(locationLabel, nearbyPlaces) {
  startInput.value = locationLabel;
  if (!destinationInput.value) {
    destinationInput.value = nearbyPlaces[0]?.name || "";
  }

  startSuggestions.innerHTML = "";
  destinationSuggestions.innerHTML = "";
  suggestionList.innerHTML = "";

  addSuggestionOption(startSuggestions, locationLabel);
  addSuggestionOption(startSuggestions, "Home");
  registerKnownPlace(locationLabel, {
    name: locationLabel,
    latitude: currentLocation?.latitude,
    longitude: currentLocation?.longitude,
  });

  nearbyPlaces.forEach((place) => {
    addSuggestionOption(startSuggestions, place.name);
    addSuggestionOption(destinationSuggestions, place.name);
    registerKnownPlace(place.name, place);
    suggestionList.append(createSuggestionChip(place.name, place));
  });

  nearbySummary.textContent = nearbyPlaces.length
    ? "Pick one of these nearby places or type your own destination."
    : "We found your location, but nearby place suggestions are limited right now.";
}

function addSuggestionOption(list, value) {
  const option = document.createElement("option");

  option.value = value;
  list.append(option);
}

function createSuggestionChip(name, place) {
  const chip = document.createElement("button");

  chip.type = "button";
  chip.className = "suggestion-chip";
  chip.textContent = `${name} (${formatDistance(place.distance)})`;
  chip.addEventListener("click", () => {
    destinationInput.value = name;
  });

  return chip;
}

function formatDistance(distance) {
  if (distance < 1000) {
    return `${Math.round(distance)} m away`;
  }

  return `${(distance / 1000).toFixed(1)} km away`;
}

function formatCoordinatesLabel(latitude, longitude) {
  return `Current location (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`;
}

function getLocationErrorMessage(error) {
  if (error?.code === 1) {
    return "Location permission was denied. Please allow location access and try again.";
  }

  if (error?.code === 2) {
    return "Your location could not be determined right now.";
  }

  if (error?.code === 3) {
    return "Location lookup took too long. Please try again.";
  }

  return "We could not access your location yet. Please try again.";
}

async function resolvePlace(query) {
  const knownPlace = knownPlaces.get(normalizePlaceKey(query));

  if (knownPlace?.latitude != null && knownPlace?.longitude != null) {
    return {
      name: knownPlace.name,
      latitude: knownPlace.latitude,
      longitude: knownPlace.longitude,
    };
  }

  if (currentLocation && query === currentLocation.label) {
    return {
      name: currentLocation.label,
      latitude: currentLocation.latitude,
      longitude: currentLocation.longitude,
    };
  }

  const searchUrl = new URL("https://nominatim.openstreetmap.org/search");

  searchUrl.searchParams.set("format", "jsonv2");
  searchUrl.searchParams.set("limit", "1");
  searchUrl.searchParams.set("q", query);

  const response = await fetch(searchUrl);

  if (!response.ok) {
    throw new Error(`We could not look up "${query}" right now.`);
  }

  const results = await response.json();
  const firstResult = results[0];

  if (!firstResult) {
    throw new Error(`We could not find "${query}". Try a fuller address.`);
  }

  return {
    name: firstResult.display_name,
    latitude: Number(firstResult.lat),
    longitude: Number(firstResult.lon),
  };
}

async function getRoute(startPlace, destinationPlace) {
  const routeUrl = new URL(
    `https://router.project-osrm.org/route/v1/driving/${startPlace.longitude},${startPlace.latitude};${destinationPlace.longitude},${destinationPlace.latitude}`,
  );

  routeUrl.searchParams.set("overview", "full");
  routeUrl.searchParams.set("geometries", "geojson");
  routeUrl.searchParams.set("steps", "true");

  const response = await fetch(routeUrl);

  if (!response.ok) {
    throw new Error("We could not fetch a driving route right now.");
  }

  const data = await response.json();
  const route = data.routes?.[0];

  if (!route) {
    throw new Error("No driving route came back for those two places.");
  }

  return route;
}

function renderRoute(route, startPlace, destinationPlace) {
  const firstLeg = route.legs?.[0];
  const allSteps = firstLeg?.steps ?? [];
  const rehearsalSteps = selectRehearsalSteps(allSteps);

  routeSummary.textContent = `From ${shortPlaceName(startPlace.name)} to ${shortPlaceName(destinationPlace.name)}. About ${formatDriveDuration(route.duration)} and ${formatDriveDistance(route.distance)}.`;

  drawRouteMap(route, startPlace, destinationPlace);
  renderRehearsalSteps(rehearsalSteps, destinationPlace);
}

function drawRouteMap(route, startPlace, destinationPlace) {
  if (!routeMap) {
    throw new Error("The map could not load in this browser.");
  }

  clearMapLayers();

  routeLayer = L.geoJSON(route.geometry, {
    style: {
      color: "#c96f4a",
      weight: 6,
      opacity: 0.9,
    },
  }).addTo(routeMap);

  routeMarkers = [
    L.marker([startPlace.latitude, startPlace.longitude])
      .addTo(routeMap)
      .bindPopup(`Start: ${shortPlaceName(startPlace.name)}`),
    L.marker([destinationPlace.latitude, destinationPlace.longitude])
      .addTo(routeMap)
      .bindPopup(`Finish: ${shortPlaceName(destinationPlace.name)}`),
  ];

  routeMap.fitBounds(routeLayer.getBounds(), {
    padding: [28, 28],
  });
  requestMapResize();
}

function renderRehearsalSteps(steps, destinationPlace) {
  routeSteps.innerHTML = "";

  if (!steps.length) {
    routeSteps.innerHTML = `
      <p class="placeholder-copy">
        The route came back, but we did not get enough turn detail to build the dry run yet.
      </p>
    `;
    return;
  }

  steps.forEach((step, index) => {
    const card = document.createElement("article");
    const label = document.createElement("p");
    const title = document.createElement("h3");
    const meta = document.createElement("p");

    card.className = "step-card";
    label.className = "step-label";
    title.className = "step-title";
    meta.className = "step-meta";

    label.textContent = rehearsalLabel(index, steps.length);
    title.textContent = buildStepInstruction(step, destinationPlace, index, steps.length);
    meta.textContent = `${formatDriveDistance(step.distance)} on this segment`;

    card.append(label, title, meta);
    routeSteps.append(card);
  });
}

function selectRehearsalSteps(steps) {
  const significantTypes = new Set([
    "depart",
    "turn",
    "new name",
    "merge",
    "fork",
    "on ramp",
    "off ramp",
    "roundabout",
    "rotary",
    "exit roundabout",
    "end of road",
    "arrive",
  ]);

  const significantSteps = steps.filter((step) =>
    significantTypes.has(step.maneuver?.type),
  );
  const firstPass = significantSteps.slice(0, 6);
  let arrivalStep = null;

  for (let index = significantSteps.length - 1; index >= 0; index -= 1) {
    if (significantSteps[index].maneuver?.type === "arrive") {
      arrivalStep = significantSteps[index];
      break;
    }
  }

  if (arrivalStep && !firstPass.includes(arrivalStep)) {
    firstPass.push(arrivalStep);
  }

  return firstPass.length ? firstPass : steps.slice(0, 5);
}

function buildStepInstruction(step, destinationPlace, index, totalSteps) {
  const type = step.maneuver?.type || "continue";
  const modifier = step.maneuver?.modifier || "";
  const roadName = step.name || "the road ahead";

  if (type === "depart") {
    return `Start out on ${roadName}.`;
  }

  if (type === "arrive" || index === totalSteps - 1) {
    return `Arrive near ${shortPlaceName(destinationPlace.name)}.`;
  }

  if (type === "roundabout" || type === "rotary") {
    return `Enter the roundabout and follow signs for ${roadName}.`;
  }

  if (type === "merge" || type === "fork") {
    return `Stay ${modifier || "with the route"} and follow ${roadName}.`;
  }

  if (type === "on ramp" || type === "off ramp") {
    return `Take the ${modifier || ""} ramp toward ${roadName}.`.replace(
      /\s+/g,
      " ",
    ).trim();
  }

  if (type === "end of road") {
    return `At the end of the road, turn ${modifier || "as directed"} onto ${roadName}.`;
  }

  if (type === "new name") {
    return `Keep going as the road becomes ${roadName}.`;
  }

  if (modifier) {
    return `Turn ${modifier} onto ${roadName}.`;
  }

  return `Continue on ${roadName}.`;
}

function rehearsalLabel(index, totalSteps) {
  if (index === 0) {
    return "Start";
  }

  if (index === totalSteps - 1) {
    return "Arrival";
  }

  return `Moment ${index}`;
}

function formatDriveDistance(distanceMeters) {
  const feet = distanceMeters * 3.28084;
  const miles = distanceMeters / 1609.344;

  if (feet < 750) {
    return `${Math.round(feet)} ft`;
  }

  if (miles < 10) {
    return `${miles.toFixed(1)} mi`;
  }

  return `${Math.round(miles)} mi`;
}

function formatDriveDuration(durationSeconds) {
  const totalMinutes = Math.round(durationSeconds / 60);

  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (!minutes) {
    return `${hours} hr`;
  }

  return `${hours} hr ${minutes} min`;
}

function shortPlaceName(placeName) {
  return placeName.split(",")[0];
}

function initializeRouteMap() {
  if (typeof window.L === "undefined") {
    setEmptyMapMessage("The map library did not load yet.");
    return;
  }

  routeMapElement.classList.remove("is-empty");
  routeMapElement.innerHTML = "";
  routeMap = L.map(routeMapElement, {
    scrollWheelZoom: false,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(routeMap);

  routeMap.setView([39.5, -98.35], 4);
  requestMapResize();
}

function resetMapView() {
  if (!routeMap) {
    setEmptyMapMessage("Preparing your route map.");
    return;
  }

  clearMapLayers();
  routeMap.setView([39.5, -98.35], 4);
  requestMapResize();
}

function drawFallbackMap(startPlace, destinationPlace) {
  if (!routeMap) {
    setEmptyMapMessage("We found the places, but the route map is not available.");
    return;
  }

  clearMapLayers();

  routeLayer = L.polyline(
    [
      [startPlace.latitude, startPlace.longitude],
      [destinationPlace.latitude, destinationPlace.longitude],
    ],
    {
      color: "#9f4f2e",
      weight: 4,
      opacity: 0.7,
      dashArray: "10 10",
    },
  ).addTo(routeMap);

  routeMarkers = [
    L.marker([startPlace.latitude, startPlace.longitude])
      .addTo(routeMap)
      .bindPopup(`Start: ${shortPlaceName(startPlace.name)}`),
    L.marker([destinationPlace.latitude, destinationPlace.longitude])
      .addTo(routeMap)
      .bindPopup(`Finish: ${shortPlaceName(destinationPlace.name)}`),
  ];

  routeMap.fitBounds(routeLayer.getBounds(), {
    padding: [28, 28],
  });
  requestMapResize();
}

function clearMapLayers() {
  if (!routeMap) {
    return;
  }

  if (routeLayer) {
    routeMap.removeLayer(routeLayer);
    routeLayer = null;
  }

  routeMarkers.forEach((marker) => routeMap.removeLayer(marker));
  routeMarkers = [];
}

function setEmptyMapMessage(message) {
  routeMapElement.classList.add("is-empty");
  routeMapElement.innerHTML = `<p class="placeholder-copy">${message}</p>`;
}

function requestMapResize() {
  if (!routeMap) {
    return;
  }

  window.setTimeout(() => {
    routeMap.invalidateSize();
  }, 50);
}

function tryGetPosition(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function normalizePlaceKey(value) {
  return value.trim().toLowerCase();
}

function registerKnownPlace(label, place) {
  if (
    !label ||
    place?.latitude == null ||
    place?.longitude == null
  ) {
    return;
  }

  knownPlaces.set(normalizePlaceKey(label), {
    name: place.name || label,
    latitude: place.latitude,
    longitude: place.longitude,
  });
}

function saveLocation(location) {
  try {
    window.localStorage.setItem(locationStorageKey, JSON.stringify(location));
  } catch (error) {
    return;
  }
}

function loadSavedLocation() {
  try {
    const savedValue = window.localStorage.getItem(locationStorageKey);

    if (!savedValue) {
      return null;
    }

    const parsedValue = JSON.parse(savedValue);

    if (
      parsedValue?.latitude == null ||
      parsedValue?.longitude == null ||
      !parsedValue?.label
    ) {
      return null;
    }

    return parsedValue;
  } catch (error) {
    return null;
  }
}

function restoreSavedLocation() {
  const savedLocation = loadSavedLocation();

  if (!savedLocation) {
    return;
  }

  currentLocation = savedLocation;
  startInput.value = savedLocation.label;
  registerKnownPlace(savedLocation.label, {
    name: savedLocation.label,
    latitude: savedLocation.latitude,
    longitude: savedLocation.longitude,
  });
  locationStatus.textContent = "Using your last saved location until you refresh it.";
}

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371000;
  const latitudeDelta = toRadians(lat2 - lat1);
  const longitudeDelta = toRadians(lon2 - lon1);
  const a =
    Math.sin(latitudeDelta / 2) * Math.sin(latitudeDelta / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(longitudeDelta / 2) *
      Math.sin(longitudeDelta / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadius * c;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}
