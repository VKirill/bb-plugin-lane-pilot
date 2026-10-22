// Public API of forecast: the pure scoring and calibration (the server part reads the facts behind ./server).
export { calibrate, calibrationLine, scoreForecast } from "./logic";
export type { Calibration, Forecast, ForecastFact, ForecastScore } from "./logic";
