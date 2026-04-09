const form = document.querySelector("#route-form");
const result = document.querySelector("#result");
const locateButton = document.querySelector("#locate-button");
const locationStatus = document.querySelector("#location-status");
const nearbySummary = document.querySelector("#nearby-summary");
const suggestionList = document.querySelector("#suggestion-list");
const startInput = document.querySelector("#start");
const destinationInput = document.querySelector("#destination");
const startSuggestions = document.querySelector("#start-suggestions");
const destinationSuggestions = document.querySelector("#destination-suggestions");

const nearbySearchRadiusMeters = 1800;

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
    const [locationLabel, nearbyPlaces] = await Promise.all([
      getLocationLabel(latitude, longitude),
      getNearbyPlaces(latitude, longitude),
    ]);

    fillSuggestions(locationLabel, nearbyPlaces);
    locationStatus.textContent = "Nearby places loaded from your location.";
  } catch (error) {
    locationStatus.textContent =
      "We could not load your nearby places. Please try again.";
  } finally {
    locateButton.disabled = false;
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const start = formData.get("start")?.toString().trim();
  const destination = formData.get("destination")?.toString().trim();

  result.innerHTML = `
    <h2>Starter preview</h2>
    <p><strong>From:</strong> ${start}</p>
    <p><strong>To:</strong> ${destination}</p>
    <p>
      Next we will replace this placeholder with a real route, a map, and a calm
      step-by-step preview of the most important moments along the drive.
    </p>
  `;
});

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 300000,
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
  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: `
      [out:json][timeout:20];
      (
        node(around:${nearbySearchRadiusMeters},${latitude},${longitude})["amenity"]["name"];
        node(around:${nearbySearchRadiusMeters},${latitude},${longitude})["shop"]["name"];
        node(around:${nearbySearchRadiusMeters},${latitude},${longitude})["tourism"]["name"];
        node(around:${nearbySearchRadiusMeters},${latitude},${longitude})["leisure"]["name"];
        node(around:${nearbySearchRadiusMeters},${latitude},${longitude})["highway"="parking"]["name"];
      );
      out body 20;
    `.trim(),
  });

  if (!response.ok) {
    throw new Error("Nearby places lookup failed.");
  }

  const data = await response.json();

  return (data.elements ?? [])
    .map((place) => ({
      name: place.tags?.name,
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
          (otherPlace) => otherPlace.name.toLowerCase() === place.name.toLowerCase(),
        ) === index,
    )
    .slice(0, 8);
}

function fillSuggestions(locationLabel, nearbyPlaces) {
  startInput.value = locationLabel;
  destinationInput.value = nearbyPlaces[0]?.name || "";

  startSuggestions.innerHTML = "";
  destinationSuggestions.innerHTML = "";
  suggestionList.innerHTML = "";

  addSuggestionOption(startSuggestions, locationLabel);
  addSuggestionOption(startSuggestions, "Home");

  nearbyPlaces.forEach((place) => {
    addSuggestionOption(startSuggestions, place.name);
    addSuggestionOption(destinationSuggestions, place.name);
    suggestionList.append(createSuggestionChip(place.name, place));
  });

  nearbySummary.textContent = nearbyPlaces.length
    ? "Pick one of these nearby places or type your own destination."
    : "We found your location, but no nearby suggestions came back just yet.";
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
