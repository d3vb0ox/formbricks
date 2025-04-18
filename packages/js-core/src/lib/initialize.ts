/* eslint-disable no-console -- required for logging */
import { type TAttributes } from "@formbricks/types/attributes";
import { type ApiErrorResponse } from "@formbricks/types/errors";
import { type TJsConfig, type TJsConfigInput } from "@formbricks/types/js";
import { updateAttributes } from "./attributes";
import { Config } from "./config";
import { JS_LOCAL_STORAGE_KEY } from "./constants";
import { fetchEnvironmentState } from "./environment-state";
import {
  ErrorHandler,
  type MissingFieldError,
  type NotInitializedError,
  type Result,
  err,
  okVoid,
  wrapThrows,
} from "./errors";
import { addCleanupEventListeners, addEventListeners, removeAllEventListeners } from "./event-listeners";
import { Logger } from "./logger";
import { checkPageUrl } from "./no-code-actions";
import { DEFAULT_PERSON_STATE_NO_USER_ID, fetchPersonState } from "./person-state";
import { filterSurveys, getIsDebug } from "./utils";
import { addWidgetContainer, removeWidgetContainer, setIsSurveyRunning } from "./widget";

const logger = Logger.getInstance();

let isInitialized = false;

export const setIsInitialized = (value: boolean): void => {
  isInitialized = value;
};

// If the js sdk is being used with user identification but there is no contactId, we can just resync
export const migrateUserStateAddContactId = (): { changed: boolean } => {
  const existingConfigString = localStorage.getItem(JS_LOCAL_STORAGE_KEY);

  if (existingConfigString) {
    const existingConfig = JSON.parse(existingConfigString) as Partial<TJsConfig>;

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- data could be undefined
    if (existingConfig.personState?.data?.contactId) {
      return { changed: false };
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- data could be undefined
    if (!existingConfig.personState?.data?.contactId && existingConfig.personState?.data?.userId) {
      return { changed: true };
    }
  }

  return { changed: false };
};

export const initialize = async (
  configInput: TJsConfigInput
): Promise<Result<void, MissingFieldError | ApiErrorResponse>> => {
  const isDebug = getIsDebug();
  if (isDebug) {
    logger.configure({ logLevel: "debug" });
  }

  let config = Config.getInstance();

  const { changed } = migrateUserStateAddContactId();

  if (changed) {
    config.resetConfig();
    config = Config.getInstance();
  }

  if (isInitialized) {
    logger.debug("Already initialized, skipping initialization.");
    return okVoid();
  }

  let existingConfig: TJsConfig | undefined;
  try {
    existingConfig = config.get();
    logger.debug("Found existing configuration.");
  } catch {
    logger.debug("No existing configuration found.");
  }

  // formbricks is in error state, skip initialization
  if (existingConfig?.status.value === "error") {
    if (isDebug) {
      logger.debug(
        "Formbricks is in error state, but debug mode is active. Resetting config and continuing."
      );
      config.resetConfig();
      return okVoid();
    }

    console.error("🧱 Formbricks - Formbricks was set to an error state.");

    const expiresAt = existingConfig.status.expiresAt;

    if (expiresAt && new Date(expiresAt) > new Date()) {
      console.error("🧱 Formbricks - Error state is not expired, skipping initialization");
      return okVoid();
    }
    console.error("🧱 Formbricks - Error state is expired. Continuing with initialization.");
  }

  ErrorHandler.getInstance().printStatus();

  logger.debug("Start initialize");

  if (!configInput.environmentId) {
    logger.debug("No environmentId provided");
    return err({
      code: "missing_field",
      field: "environmentId",
    });
  }

  if (!configInput.apiHost) {
    logger.debug("No apiHost provided");

    return err({
      code: "missing_field",
      field: "apiHost",
    });
  }

  logger.debug("Adding widget container to DOM");
  addWidgetContainer();

  if (
    existingConfig?.environmentState &&
    existingConfig.environmentId === configInput.environmentId &&
    existingConfig.apiHost === configInput.apiHost
  ) {
    logger.debug("Configuration fits init parameters.");
    let isEnvironmentStateExpired = false;
    let isPersonStateExpired = false;

    if (new Date(existingConfig.environmentState.expiresAt) < new Date()) {
      logger.debug("Environment state expired. Syncing.");
      isEnvironmentStateExpired = true;
    }

    if (
      configInput.userId &&
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- personState could be null
      (existingConfig.personState === null ||
        (existingConfig.personState.expiresAt && new Date(existingConfig.personState.expiresAt) < new Date()))
    ) {
      logger.debug("Person state needs syncing - either null or expired");
      isPersonStateExpired = true;
    }

    try {
      // fetch the environment state (if expired)
      const environmentState = isEnvironmentStateExpired
        ? await fetchEnvironmentState({
            apiHost: configInput.apiHost,
            environmentId: configInput.environmentId,
          })
        : existingConfig.environmentState;

      // fetch the person state (if expired)

      let { personState } = existingConfig;

      if (isPersonStateExpired) {
        if (configInput.userId) {
          personState = await fetchPersonState({
            apiHost: configInput.apiHost,
            environmentId: configInput.environmentId,
            userId: configInput.userId,
          });
        } else {
          personState = DEFAULT_PERSON_STATE_NO_USER_ID;
        }
      }

      // filter the environment state wrt the person state
      const filteredSurveys = filterSurveys(environmentState, personState);

      // update the appConfig with the new filtered surveys
      config.update({
        ...existingConfig,
        environmentState,
        personState,
        filteredSurveys,
        attributes: configInput.attributes ?? {},
      });

      const surveyNames = filteredSurveys.map((s) => s.name);
      logger.debug(`Fetched ${surveyNames.length.toString()} surveys during sync: ${surveyNames.join(", ")}`);
    } catch {
      putFormbricksInErrorState(config);
    }
  } else {
    logger.debug("No valid configuration found. Resetting config and creating new one.");
    config.resetConfig();
    logger.debug("Syncing.");

    try {
      const environmentState = await fetchEnvironmentState(
        {
          apiHost: configInput.apiHost,
          environmentId: configInput.environmentId,
        },
        false
      );

      const personState = configInput.userId
        ? await fetchPersonState(
            {
              apiHost: configInput.apiHost,
              environmentId: configInput.environmentId,
              userId: configInput.userId,
            },
            false
          )
        : DEFAULT_PERSON_STATE_NO_USER_ID;

      const filteredSurveys = filterSurveys(environmentState, personState);

      let updatedAttributes: TAttributes | null = null;
      if (configInput.attributes) {
        if (configInput.userId) {
          const res = await updateAttributes(
            configInput.apiHost,
            configInput.environmentId,
            configInput.userId,
            configInput.attributes
          );

          if (!res.ok) {
            if (res.error.code === "forbidden") {
              logger.error(`Authorization error: ${res.error.responseMessage ?? ""}`);
            }
            return err(res.error);
          }

          updatedAttributes = res.value;
        } else {
          updatedAttributes = { ...configInput.attributes };
        }
      }

      config.update({
        apiHost: configInput.apiHost,
        environmentId: configInput.environmentId,
        personState,
        environmentState,
        filteredSurveys,
        attributes: updatedAttributes ?? {},
      });
    } catch (e) {
      handleErrorOnFirstInit(e);
    }
  }

  logger.debug("Adding event listeners");
  addEventListeners();
  addCleanupEventListeners();

  setIsInitialized(true);
  logger.debug("Initialized");

  // check page url if initialized after page load

  void checkPageUrl();
  return okVoid();
};

export const handleErrorOnFirstInit = (e: unknown): void => {
  const error = e as ApiErrorResponse;
  if (error.code === "forbidden") {
    logger.error(`Authorization error: ${error.responseMessage ?? ""}`);
  }

  if (getIsDebug()) {
    logger.debug("Not putting formbricks in error state because debug mode is active (no error state)");
    return;
  }

  // put formbricks in error state (by creating a new config) and throw error
  const initialErrorConfig: Partial<TJsConfig> = {
    status: {
      value: "error",
      expiresAt: new Date(new Date().getTime() + 10 * 60000), // 10 minutes in the future
    },
  };

  // can't use config.update here because the config is not yet initialized
  wrapThrows(() => {
    localStorage.setItem(JS_LOCAL_STORAGE_KEY, JSON.stringify(initialErrorConfig));
  })();
  throw new Error("Could not initialize formbricks");
};

export const checkInitialized = (): Result<void, NotInitializedError> => {
  logger.debug("Check if initialized");
  if (!isInitialized || !ErrorHandler.initialized) {
    return err({
      code: "not_initialized",
      message: "Formbricks not initialized. Call initialize() first.",
    });
  }

  return okVoid();
};

export const deinitalize = (): void => {
  logger.debug("Deinitializing");
  removeWidgetContainer();
  setIsSurveyRunning(false);
  removeAllEventListeners();
  setIsInitialized(false);
};

export const putFormbricksInErrorState = (formbricksConfig: Config): void => {
  if (getIsDebug()) {
    logger.debug("Not putting formbricks in error state because debug mode is active (no error state)");
    return;
  }

  logger.debug("Putting formbricks in error state");
  // change formbricks status to error
  formbricksConfig.update({
    ...formbricksConfig.get(),
    status: {
      value: "error",
      expiresAt: new Date(new Date().getTime() + 10 * 60000), // 10 minutes in the future
    },
  });
  deinitalize();
};
