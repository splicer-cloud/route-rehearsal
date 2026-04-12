const routeStorageKey = "route-rehearsal:latest-route";
const googleMapsApiKeyStorageKey = "route-rehearsal:google-maps-api-key";

const tilesApiKeyInput = document.querySelector("#tiles-api-key");
const saveTilesKeyButton = document.querySelector("#save-tiles-key");
const tilesKeyStatus = document.querySelector("#tiles-key-status");
const routeStatus = document.querySelector("#three-drive-route-status");
const reloadRouteButton = document.querySelector("#three-drive-reload-route");
const loadSceneButton = document.querySelector("#three-drive-load-scene");
const playButton = document.querySelector("#three-drive-play");
const pauseButton = document.querySelector("#three-drive-pause");
const resetButton = document.querySelector("#three-drive-reset");
const progressBar = document.querySelector("#three-drive-progress-bar");
const playbackStatus = document.querySelector("#three-drive-playback-status");
const viewElement = document.querySelector("#three-drive-view");

let viewer = null;
let tileset = null;
let routeEntity = null;
let routePayload = null;
let playbackPoints = [];
let ridePoints = [];
let playbackProgress = 0;
let playbackFrame = null;
let playbackActive = false;
let playbackStartedAt = 0;
let playbackDuration = 26000;
let lastCameraHeading = null;
let routePrepared = false;

restoreApiKey();
loadSavedRoute();
updatePlaybackUi();
checkCesiumAvailability();

saveTilesKeyButton.addEventListener("click", () => {
  const apiKey = tilesApiKeyInput.value.trim();

  if (!apiKey) {
    clearApiKey();
    updateKeyStatus();
    return;
  }

  saveApiKey(apiKey);
  updateKeyStatus();
});

loadSceneButton.addEventListener("click", async () => {
  await loadScene();
});

reloadRouteButton.addEventListener("click", async () => {
  loadSavedRoute();
  routePrepared = false;
  if (viewer && routePayload?.route?.geometry?.coordinates?.length) {
    playbackPoints = routePayload.route.geometry.coordinates;
    drawRouteLine();
    await prepareStreetLevelRide();
  }
  updatePlaybackUi();
});

playButton.addEventListener("click", () => {
  startPlayback();
});

pauseButton.addEventListener("click", () => {
  pausePlayback();
});

resetButton.addEventListener("click", () => {
  resetPlayback();
});

function restoreApiKey() {
  const apiKey = loadApiKey();

  if (apiKey) {
    tilesApiKeyInput.value = apiKey;
  }

  updateKeyStatus();
}

function updateKeyStatus() {
  const apiKey = loadApiKey();

  tilesKeyStatus.textContent = apiKey
    ? `Map Tiles key saved in this browser (ends in ${apiKey.slice(-4)}).`
    : "Paste a Google Maps key with Map Tiles API enabled.";
}

function loadSavedRoute() {
  try {
    const savedRoute = window.localStorage.getItem(routeStorageKey);

    if (!savedRoute) {
      routePayload = null;
      routeStatus.textContent =
        "Return to the main app, build a route, then come back here.";
      return;
    }

    routePayload = JSON.parse(savedRoute);
    playbackPoints = routePayload.route?.geometry?.coordinates ?? [];
    ridePoints = [];
    routePrepared = false;
    routeStatus.textContent = `Loaded route from ${shortPlaceName(routePayload.startPlace.name)} to ${shortPlaceName(routePayload.destinationPlace.name)}.`;
    playbackStatus.textContent =
      "Load the 3D scene, then play the camera ride.";
  } catch (error) {
    routePayload = null;
    routeStatus.textContent =
      "The saved route could not be read yet. Build a new route first.";
  }
}

async function loadScene() {
  if (typeof window.Cesium === "undefined") {
    playbackStatus.textContent =
      "The 3D engine did not load. Refresh the page and try again.";
    return;
  }

  const apiKey = loadApiKey();

  if (!apiKey) {
    playbackStatus.textContent =
      "Add a Google Maps key with Map Tiles API enabled first.";
    return;
  }

  if (!routePayload?.route?.geometry?.coordinates?.length) {
    playbackStatus.textContent =
      "No route is available yet. Build one in the main app first.";
    return;
  }

  try {
    if (!viewer) {
      Cesium.Ion.defaultAccessToken = "";
      Cesium.RequestScheduler.requestsByServer["tile.googleapis.com:443"] = 18;

      viewer = new Cesium.Viewer("three-drive-view", {
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        globe: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        selectionIndicator: false,
        requestRenderMode: false,
        imageryProvider: false,
      });
      viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
    }

    if (!tileset) {
      tileset = viewer.scene.primitives.add(
        new Cesium.Cesium3DTileset({
          url: `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(apiKey)}`,
          showCreditsOnScreen: true,
        }),
      );
      await tileset.readyPromise;
    }

    drawRouteLine();
    await prepareStreetLevelRide();
    playbackStatus.textContent =
      "3D scene prepared. Press play for the street-level ride.";
  } catch (error) {
    playbackStatus.textContent =
      "The 3D scene did not load. Check the Map Tiles API key, Map Tiles API access, and refresh once.";
  }
}

function drawRouteLine() {
  if (!viewer || !routePayload) {
    return;
  }

  if (routeEntity) {
    viewer.entities.remove(routeEntity);
  }

  const positions = routePayload.route.geometry.coordinates.map(([longitude, latitude]) =>
    Cesium.Cartesian3.fromDegrees(longitude, latitude, 4),
  );

  routeEntity = viewer.entities.add({
    polyline: {
      positions,
      width: 6,
      material: Cesium.Color.fromCssColorString("#c96f4a"),
    },
  });

  viewer.zoomTo(routeEntity);
}

function startPlayback() {
  if (!viewer || !ridePoints.length || !routePrepared) {
    playbackStatus.textContent =
      "Load and prepare the 3D scene before playing the ride.";
    return;
  }

  playbackActive = true;
  playbackStartedAt = performance.now() - playbackProgress * playbackDuration;
  playbackStatus.textContent = "Playing street-level 3D route preview...";
  updatePlaybackUi();
  playbackFrame = window.requestAnimationFrame(stepPlayback);
}

function pausePlayback() {
  playbackActive = false;

  if (playbackFrame) {
    window.cancelAnimationFrame(playbackFrame);
    playbackFrame = null;
  }

  updatePlaybackUi();
}

function resetPlayback() {
  pausePlayback();
  playbackProgress = 0;
  lastCameraHeading = null;
  progressBar.style.width = "0%";

  if (ridePoints.length) {
    flyCameraToProgress(0);
  }

  playbackStatus.textContent = viewer
    ? "3D scene prepared. Press play for the street-level ride."
    : "The 3D ride is waiting for a loaded scene and route.";
  updatePlaybackUi();
}

function stepPlayback(timestamp) {
  if (!playbackActive || !ridePoints.length) {
    return;
  }

  playbackProgress = Math.min(1, (timestamp - playbackStartedAt) / playbackDuration);
  flyCameraToProgress(playbackProgress);
  progressBar.style.width = `${Math.round(playbackProgress * 100)}%`;
  playbackStatus.textContent = `Playing street-level 3D route preview... ${Math.round(
    playbackProgress * 100,
  )}%`;

  if (playbackProgress >= 1) {
    pausePlayback();
    playbackStatus.textContent = "3D ride complete. Reset to watch again.";
    return;
  }

  playbackFrame = window.requestAnimationFrame(stepPlayback);
}

function flyCameraToProgress(progress) {
  if (!viewer || !ridePoints.length) {
    return;
  }

  const currentPoint = interpolateRidePoint(ridePoints, progress);
  const nextPoint = interpolateRidePoint(ridePoints, Math.min(1, progress + 0.018));
  const heading = calculateBearing(
    currentPoint.latitude,
    currentPoint.longitude,
    nextPoint.latitude,
    nextPoint.longitude,
  );
  const smoothedHeading =
    lastCameraHeading == null ? heading : smoothHeading(lastCameraHeading, heading, 0.28);
  const height = currentPoint.height + 2.8;

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      currentPoint.longitude,
      currentPoint.latitude,
      height,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(smoothedHeading),
      pitch: Cesium.Math.toRadians(-2.5),
      roll: 0,
    },
  });
  lastCameraHeading = smoothedHeading;
}

function interpolateRouteCoordinate(coordinates, progress) {
  if (coordinates.length === 1) {
    return coordinates[0];
  }

  const scaledIndex = (coordinates.length - 1) * progress;
  const lowerIndex = Math.floor(scaledIndex);
  const upperIndex = Math.min(coordinates.length - 1, lowerIndex + 1);
  const mix = scaledIndex - lowerIndex;
  const startCoordinate = coordinates[lowerIndex];
  const endCoordinate = coordinates[upperIndex];

  return [
    interpolateValue(startCoordinate[0], endCoordinate[0], mix),
    interpolateValue(startCoordinate[1], endCoordinate[1], mix),
  ];
}

async function prepareStreetLevelRide() {
  if (!viewer || !routePayload?.route?.geometry?.coordinates?.length) {
    return;
  }

  playbackStatus.textContent =
    "Preparing street-level ride and warming up nearby 3D tiles...";
  routePrepared = false;
  playbackPoints = routePayload.route.geometry.coordinates;
  ridePoints = buildEvenlySpacedRoutePoints(playbackPoints, 160);
  playbackDuration = clampValue(ridePoints.length * 150, 22000, 46000);

  await preloadRideTiles(ridePoints);
  ridePoints = ridePoints.map((point) => ({
    ...point,
    height: getSceneHeight(point.latitude, point.longitude),
  }));
  routePrepared = true;
  resetPlayback();
}

async function preloadRideTiles(points) {
  const preloadPoints = sampleRidePoints(points, 10);

  for (const point of preloadPoints) {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        point.longitude,
        point.latitude,
        95,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(point.heading),
        pitch: Cesium.Math.toRadians(-35),
        roll: 0,
      },
    });
    await waitForTilesToSettle(900);
  }
}

function waitForTilesToSettle(timeoutMs) {
  return new Promise((resolve) => {
    let settledFrames = 0;
    const startedAt = performance.now();

    function check() {
      const pendingTiles = tileset?.statistics?.numberOfPendingRequests || 0;
      const processingTiles = tileset?.statistics?.numberProcessing || 0;

      if (!pendingTiles && !processingTiles) {
        settledFrames += 1;
      } else {
        settledFrames = 0;
      }

      if (settledFrames >= 2 || performance.now() - startedAt > timeoutMs) {
        resolve();
        return;
      }

      window.requestAnimationFrame(check);
    }

    check();
  });
}

function buildEvenlySpacedRoutePoints(coordinates, pointCount) {
  if (!coordinates.length) {
    return [];
  }

  const measuredDistance = measureCoordinatePath(coordinates);

  if (!measuredDistance) {
    return coordinates.map(([longitude, latitude]) => ({
      latitude,
      longitude,
      heading: 0,
      height: 20,
    }));
  }

  const points = [];

  for (let index = 0; index < pointCount; index += 1) {
    const progress = index / Math.max(pointCount - 1, 1);
    const coordinate = interpolateCoordinateAtDistance(
      coordinates,
      measuredDistance * progress,
    );
    const nextCoordinate = interpolateCoordinateAtDistance(
      coordinates,
      measuredDistance * Math.min(1, progress + 0.01),
    );

    points.push({
      latitude: coordinate[1],
      longitude: coordinate[0],
      heading: calculateBearing(
        coordinate[1],
        coordinate[0],
        nextCoordinate[1],
        nextCoordinate[0],
      ),
      height: 20,
    });
  }

  return points;
}

function sampleRidePoints(points, sampleCount) {
  if (points.length <= sampleCount) {
    return points;
  }

  const samples = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const pointIndex = Math.round(
      (points.length - 1) * (index / Math.max(sampleCount - 1, 1)),
    );

    samples.push(points[pointIndex]);
  }

  return samples;
}

function interpolateRidePoint(points, progress) {
  if (points.length === 1) {
    return points[0];
  }

  const scaledIndex = (points.length - 1) * progress;
  const lowerIndex = Math.floor(scaledIndex);
  const upperIndex = Math.min(points.length - 1, lowerIndex + 1);
  const mix = scaledIndex - lowerIndex;
  const startPoint = points[lowerIndex];
  const endPoint = points[upperIndex];

  return {
    latitude: interpolateValue(startPoint.latitude, endPoint.latitude, mix),
    longitude: interpolateValue(startPoint.longitude, endPoint.longitude, mix),
    height: interpolateValue(startPoint.height, endPoint.height, mix),
    heading: interpolateValue(startPoint.heading, endPoint.heading, mix),
  };
}

function getSceneHeight(latitude, longitude) {
  if (!viewer?.scene?.sampleHeight) {
    return 20;
  }

  const cartographic = Cesium.Cartographic.fromDegrees(longitude, latitude);
  const sampledHeight = viewer.scene.sampleHeight(cartographic);

  if (Number.isFinite(sampledHeight)) {
    return sampledHeight;
  }

  return 20;
}

function measureCoordinatePath(coordinates) {
  let totalDistance = 0;

  for (let index = 1; index < coordinates.length; index += 1) {
    totalDistance += coordinateDistance(coordinates[index - 1], coordinates[index]);
  }

  return totalDistance;
}

function interpolateCoordinateAtDistance(coordinates, targetDistance) {
  if (targetDistance <= 0) {
    return coordinates[0];
  }

  let traveledDistance = 0;

  for (let index = 1; index < coordinates.length; index += 1) {
    const previousCoordinate = coordinates[index - 1];
    const nextCoordinate = coordinates[index];
    const segmentDistance = coordinateDistance(previousCoordinate, nextCoordinate);

    if (traveledDistance + segmentDistance >= targetDistance) {
      const remainingDistance = targetDistance - traveledDistance;
      const mix = segmentDistance ? remainingDistance / segmentDistance : 0;

      return [
        interpolateValue(previousCoordinate[0], nextCoordinate[0], mix),
        interpolateValue(previousCoordinate[1], nextCoordinate[1], mix),
      ];
    }

    traveledDistance += segmentDistance;
  }

  return coordinates[coordinates.length - 1];
}

function coordinateDistance(startCoordinate, endCoordinate) {
  return calculateDistanceMeters(
    startCoordinate[1],
    startCoordinate[0],
    endCoordinate[1],
    endCoordinate[0],
  );
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

function interpolateValue(start, end, amount) {
  return start + (end - start) * amount;
}

function calculateBearing(lat1, lon1, lat2, lon2) {
  const startLatitude = toRadians(lat1);
  const startLongitude = toRadians(lon1);
  const endLatitude = toRadians(lat2);
  const endLongitude = toRadians(lon2);
  const longitudeDelta = endLongitude - startLongitude;
  const y = Math.sin(longitudeDelta) * Math.cos(endLatitude);
  const x =
    Math.cos(startLatitude) * Math.sin(endLatitude) -
    Math.sin(startLatitude) *
      Math.cos(endLatitude) *
      Math.cos(longitudeDelta);

  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function smoothHeading(previousHeading, nextHeading, weight) {
  const delta = ((((nextHeading - previousHeading) % 360) + 540) % 360) - 180;

  return (previousHeading + delta * weight + 360) % 360;
}

function clampValue(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function toDegrees(value) {
  return (value * 180) / Math.PI;
}

function updatePlaybackUi() {
  const hasScene = Boolean(viewer);
  const hasRoute = Boolean(routePayload?.route?.geometry?.coordinates?.length);

  playButton.disabled = !hasScene || !hasRoute || !routePrepared || playbackActive;
  pauseButton.disabled = !playbackActive;
  resetButton.disabled = !hasScene || !hasRoute;
}

function checkCesiumAvailability() {
  if (typeof window.Cesium !== "undefined") {
    return;
  }

  playbackStatus.textContent =
    "The 3D engine did not load yet. Refresh the page before trying the 3D ride.";
  loadSceneButton.disabled = true;
}

function shortPlaceName(placeName) {
  return placeName.split(",")[0];
}

function saveApiKey(apiKey) {
  window.localStorage.setItem(googleMapsApiKeyStorageKey, apiKey);
}

function loadApiKey() {
  return window.localStorage.getItem(googleMapsApiKeyStorageKey) || "";
}

function clearApiKey() {
  window.localStorage.removeItem(googleMapsApiKeyStorageKey);
}
