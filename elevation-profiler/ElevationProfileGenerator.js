import along from "@turf/along";
import length from "@turf/length";
import SphericalMercator from "@mapbox/sphericalmercator"
import TileCover from "@mapbox/tile-cover"
import getPixels from "get-pixels"

const ZOOM_LEVEL = 15;
const TILE_SIZE = 256;
let requiredTilesObjects = [];
let tilePromises = [];
let minKmBetweenPoints = null;


/**
 * Takes a GeoJSON LineString and returns a GeoJSON FeatureCollection of points along that LineString. Each point feature has
 * an "elevation" property that contains the elevation in meters at that point.
 *
 * @access public
 *
 * @param {Object} lineString                          The GeoJSON LineString feature to be checked.
 * @param {number} numberOfPoints                      The maximum number of points to check along the LineString.
 * @param {string} mapboxAccessToken                   The mapbox access token to be used to retrieve rgb elevation
 *                                                     tiles.
 * @param {number} [minMetersBetweenPoints=undefined]  The minimum distance in meters to use between each point on the
 *                                                     LineString. Leaving this parameter as its default results in
 *                                                     calculating the approximate pixel distance at the used zoom
 *                                                     level and using that as the minimum distance. Passing null
 *                                                     results in no minimum being applied, so numberOfPoints points
 *                                                     are checked regardless of LineString length.
 *
 * @return {Promise}                                   A Promise whose result is a GeoJSON FeatureCollection containing
 *                                                     all checked points along the LineString. The calculated
 *                                                     elevation is contained in the feature's properties attributes
 *                                                     with key "elevation".
 */
export default async function getLineStringElevationPoints(lineString,
                                                           numberOfPoints,
                                                           mapboxAccessToken,
                                                           minMetersBetweenPoints = undefined) {
    return new Promise((resolve, reject) => {
        try {
            requiredTilesObjects = [];
            tilePromises = [];
            if (minMetersBetweenPoints === undefined) {
                minKmBetweenPoints = Math.ceil(_getPixelDistanceAtLatitudeInMeters(lineString.geometry.coordinates[0][1]) * 10) / 10000;
            } else if (minMetersBetweenPoints === null) {
                minKmBetweenPoints = null;
            } else {
                minKmBetweenPoints = minMetersBetweenPoints / 1000;
            }

            let pointsToCheck = _getLineStringPoints(lineString, numberOfPoints);
            _getTileArrayFromLineString(lineString, ZOOM_LEVEL, ZOOM_LEVEL, mapboxAccessToken);
            _addXYZCoordinatesToPointsGeoJSON(pointsToCheck, ZOOM_LEVEL);

            Promise.all(tilePromises).then(function () {
                _addHeightToPointsGeoJSON(pointsToCheck);
                resolve(_getFormattedPointsResult(pointsToCheck));
            }).catch(function (error) {
                reject(error);
            });
        } catch (error) {
            reject(error)
        }
    })
}

function _getLineStringPoints(lineString, numberOfPoints) {
    let distancesToCheck = _getLineStringDistancesToCheck(lineString, numberOfPoints);
    let pointsToCheck = _getPointsToCheck(lineString, distancesToCheck);
    return pointsToCheck
}

function _getLineStringDistancesToCheck(lineString, numberOfPoints) {
    let lineStringLength = length(lineString, {units: "kilometers"});
    let stepDistance = lineStringLength / (numberOfPoints - 1);
    if (minKmBetweenPoints !== null && stepDistance < minKmBetweenPoints) {
        stepDistance = minKmBetweenPoints;
    }

    let distances = [];
    for (let i = 0; (i < numberOfPoints - 1) && (stepDistance * i < lineStringLength); i++) {
        distances.push(stepDistance * i);
    }
    distances.push(lineStringLength);

    return distances
}

function _getPointsToCheck(lineString, distancesToCheck) {
    let points = [];
    distancesToCheck.forEach(function (distance) {
        let feature = along(lineString, distance, {units: "kilometers"});
        feature.properties.distanceAlongLine = distance * 1000;
        points.push(feature);
    });
    return points;
}

function _addXYZCoordinatesToPointsGeoJSON(pointsArray, zoomLevel) {
    let sphericalMercator = new SphericalMercator({
        size: TILE_SIZE
    });

    pointsArray.forEach(function (pointGeoJSON) {
        let pointSMCoordinates = sphericalMercator.px([pointGeoJSON.geometry.coordinates[0], pointGeoJSON.geometry.coordinates[1]], zoomLevel);
        pointGeoJSON.properties.smCoordinates = {
            x: pointSMCoordinates[0],
            y: pointSMCoordinates[1]
        }
    });
}

function _getTileArrayFromLineString(lineString, minZoom, maxZoom, mapboxAccessToken) {
    let requiredTiles2DArray = TileCover.tiles(lineString.geometry, {min_zoom: minZoom, max_zoom: maxZoom});
    requiredTiles2DArray.forEach(function (requiredTile, index) {
        let x = requiredTile[0];
        let y = requiredTile[1];
        let z = requiredTile[2];
        requiredTilesObjects.push({
            coordinates: {
                x: x,
                y: y,
                z: z
            },
            smCoordinates: {
                x: x * TILE_SIZE,
                y: y * TILE_SIZE,
            },
            tileData: null
        });
        _getTerrainTilePixelArray(x, y, z, index, mapboxAccessToken)
    });
}

function _getTerrainTilePixelArray(x, y, z, requiredTilesObjectsIndex, access_token) {
    tilePromises.push(_getPromisifiedTileRequest(x, y, z, access_token).then(function (pixels) {
        requiredTilesObjects[requiredTilesObjectsIndex].tileData = pixels;
    }))
}

function _getPromisifiedTileRequest(x, y, z, access_token) {
    return new Promise((resolve, reject) => {
        getPixels(`https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}.pngraw?access_token=${access_token}`, function (error, pixels) {
            if (error) {
                reject(error);
            }
            resolve(pixels);
        })
    })
}

function _addHeightToPointsGeoJSON(points) {
    points.forEach(function (point) {
        let matchingTile = requiredTilesObjects.filter(function (tile) {
            return _pointIsWithinTile(point.properties.smCoordinates, tile.smCoordinates)
        })[0];
        let xRelativeToTile = point.properties.smCoordinates.x - matchingTile.smCoordinates.x;
        let yRelativeToTile = point.properties.smCoordinates.y - matchingTile.smCoordinates.y;
        point.properties.elevation = _calculateHeightFromPixel([
            matchingTile.tileData.get(xRelativeToTile, yRelativeToTile, 0),
            matchingTile.tileData.get(xRelativeToTile, yRelativeToTile, 1),
            matchingTile.tileData.get(xRelativeToTile, yRelativeToTile, 2)
        ]);
    });
}

function _calculateHeightFromPixel(pixelRGBArray) {
    let red = pixelRGBArray[0];
    let green = pixelRGBArray[1];
    let blue = pixelRGBArray[2];
    return -10000 + ((red * 256 * 256 + green * 256 + blue) * 0.1);
}

function _pointIsWithinTile(pointSMCoordinates, tileSMCoordinates) {
    return pointSMCoordinates.x >= tileSMCoordinates.x
        && pointSMCoordinates.x <= (tileSMCoordinates.x + TILE_SIZE)
        && pointSMCoordinates.y >= tileSMCoordinates.y
        && pointSMCoordinates.y <= (tileSMCoordinates.y + TILE_SIZE)
}

function _getFormattedPointsResult(points) {
    let featureCollection = {
        type: "FeatureCollection",
        features: []
    };

    points.forEach(function (point) {
        let pointCopy = JSON.parse(JSON.stringify(point));
        delete pointCopy.properties.smCoordinates;
        featureCollection.features.push(pointCopy);
    });

    return featureCollection
}

function _getPixelDistanceAtLatitudeInMeters(latitude) {
    const EQUATORIAL_EARTH_CIRCUMFERENCE = 40075016.686;
    return EQUATORIAL_EARTH_CIRCUMFERENCE * (Math.cos(latitude * Math.PI / 180) / Math.pow(2, ZOOM_LEVEL + 8));
}