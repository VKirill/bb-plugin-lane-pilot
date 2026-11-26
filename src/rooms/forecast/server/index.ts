// Public API of forecast/server: the report, the command, and the room descriptor.
export { room } from "./room";
export { FORECAST_USAGE, runForecastCli } from "./handlers/forecast-cli";
export { calibrationPassport, forecastReport, weakAreas } from "./services/report";
export type { CalibrationPassport, ForecastReport, ForecastRow } from "./services/report";
