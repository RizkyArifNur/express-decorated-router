import * as debug from 'debug';
import {RequestHandler, Router as createRouter, RouterOptions} from 'express';
import {IRouter, PathParams} from 'express-serve-static-core';
import forEach = require('lodash/forEach');
import isEmpty = require('lodash/isEmpty');
import {ParentControllerError} from './errors/ParentControllerError';
import {UnregisteredControllerError} from './errors/UnregisteredControllerError';

/** Shorthand for a path to request handler map */
type HttpMethodSpec = Map<PathParams, RequestHandler>;

/** A route spec where HTTP methods are mapped to {@link HttpMethodSpec}s */
interface RouteSpec {
  [httpMethod: string]: HttpMethodSpec;
}

/** Controller definition */
interface ControllerSpec {
  /** Options passed to {@link Router express.Router()} */
  opts?: RouterOptions;
  /** The root path of this controller */
  root: PathParams;
}

/** key = controller class */
const routeMap = new Map<Function, RouteSpec>();
/** key = controller class */
const controllerMap = new Map<Function, ControllerSpec>();
/** key = controller class */
const controllerMiddlewareMap = new Map<Function, RequestHandler[]>();
/** key = class method */
const routeMiddlewareMap = new Map<RequestHandler, RequestHandler[]>();
/** key = controller class */
const routerMap = new Map<Function, IRouter>();
/** key = child, value = parent */
const parentMap = new Map<Function, Function>();

/** Debug logger */
const log = debug('express-decorated-router');

/** Public interface for the express-decorated-router library */
export class ExpressDecoratedRouter {

  /**
   * Register a {@link Controller @Controller} decoration
   * @internal
   * @hidden
   * @param clazz Controller class
   * @param root Controller root path
   * @param opts Options passed to {@link Router express.Router()}
   */
  public static addController(clazz: Function, root: PathParams, opts?: RouterOptions): void {
    controllerMap.set(clazz, {root, opts});
    log(
      'Decorating class %s as a controller with root %s and options %o',
      clazz.name,
      root,
      opts
    );
  }

  /**
   * Register a {@link ControllerMiddleware @ControllerMiddleware} decoration
   * @internal
   * @hidden
   * @param clazz Controller class
   * @param middleware Middleware handlers
   */
  public static addControllerMiddleware(clazz: Function, middleware: RequestHandler[]): void {
    controllerMiddlewareMap.set(clazz, middleware);
    log('Adding %d middleware functions to controller %s', middleware.length, clazz.name);
  }

  /**
   * Register a {@link Parent @Parent} decoration
   * @internal
   * @hidden
   * @param child Child controller
   * @param parent Parent controller
   */
  public static addParent(child: Function, parent: Function): void {
    log('Setting %s as the parent controller of %s', parent.name, child.name);
    parentMap.set(child, parent);
  }

  /**
   * Register a route decoration
   * @internal
   * @hidden
   * @param clazz Controller class
   * @param httpMethod The HTTP method
   * @param path The URL path
   * @param handler The request handler
   */
  public static addRoute(clazz: Function, httpMethod: string, path: PathParams, handler: RequestHandler): void {
    log('Adding %s %s route to controller %s', httpMethod.toUpperCase(), path, clazz.name);
    let routeSpec: RouteSpec = <RouteSpec>routeMap.get(clazz);

    /* istanbul ignore else */
    if (!routeSpec) {
      log('Route spec object does not exist - creating');
      routeSpec = {};
      routeMap.set(clazz, routeSpec);
    } else {
      log('Route spec object already exists');
    }

    let httpMethodSpec: HttpMethodSpec = routeSpec[httpMethod];
    /* istanbul ignore else */
    if (!httpMethodSpec) {
      log('Http spec map does not exist - creating');
      httpMethodSpec = new Map<PathParams, RequestHandler>();
      routeSpec[httpMethod] = httpMethodSpec;
    } else {
      log('Http spec map already exists');
    }

    httpMethodSpec.set(path, handler);
  }

  /**
   * Register a {@link RouteMiddleware @RouteMiddleware} decoration
   * @internal
   * @hidden
   * @param route The decorated method
   * @param middleware The middleware functions
   */
  public static addRouteMiddleware(route: RequestHandler, middleware: RequestHandler[]): void {
    routeMiddlewareMap.set(route, middleware);
    log('Adding %s middleware functions to handler %s', middleware.length, route.name);
  }

  /**
   * Apply routes to the Express application. You should call reset() after calling this.
   * @param app The Express application
   * @throws {ParentControllerError} If the input of a @Parent decoration has not been decorated with @Controller
   * @throws {UnregisteredControllerError} If a class decorated with @Parent was not annotated with @Controller
   */
  public static applyRoutes(app: IRouter): typeof ExpressDecoratedRouter {
    log('Applying routes to Express app');

    for (const controllerMapEntry of controllerMap.entries()) {
      ExpressDecoratedRouter.processController(app, controllerMapEntry[0], controllerMapEntry[1]);
    }
    for (const parentMapEntry of parentMap.entries()) {
      ExpressDecoratedRouter.processParents(parentMapEntry[0], parentMapEntry[1]);
    }

    return ExpressDecoratedRouter;
  }

  /**
   * Reset the library, freeing resources. You should call this method after calling applyRoutes()
   */
  public static reset(): typeof ExpressDecoratedRouter {
    log('Resetting route map');
    routeMap.clear();

    log('Resetting controller map');
    controllerMap.clear();

    log('Resetting controller middleware map');
    controllerMiddlewareMap.clear();

    log('Resetting route middleware map');
    routeMiddlewareMap.clear();

    log('Resetting router map');
    routerMap.clear();

    log('Resetting parent map');
    parentMap.clear();

    return ExpressDecoratedRouter;
  }

  /**
   * Process a Controller decoration
   * @internal
   * @hidden
   * @param app The Express app
   * @param controller The controller class
   * @param controllerSpec The controller specification
   */
  private static processController(app: IRouter, controller: Function, controllerSpec: ControllerSpec): void {
    log('Resolved controller as %s, controller spec as %o', controller.name, controllerSpec);

    if (!routeMap.has(controller)) {
      log('Controller %s has no routes - skipping', controller.name);

      return;
    }
    const routeSpec: RouteSpec = <RouteSpec>routeMap.get(controller);
    if (isEmpty(routeSpec)) {
      log('Controller %s has an empty route spec - skipping', controller.name);

      return;
    }

    const router: IRouter = createRouter(controllerSpec.opts);

    ExpressDecoratedRouter.processControllerMiddleware(router, controller);

    log('Parsing route specs for controller %s', controller.name);
    forEach(routeSpec, (httpMethodSpec: HttpMethodSpec, httpMethod: string): void => {
      ExpressDecoratedRouter.processRouteSpec(router, controller, httpMethod, httpMethodSpec);
    });

    log(
      'Adding controller %s with root %s and options %o to app',
      controller.name,
      controllerSpec.root,
      controllerSpec.opts
    );
    routerMap.set(controller, router);

    if (!parentMap.has(controller)) {
      app.use(controllerSpec.root, router);
    }
  }

  /**
   * Process a ControllerMiddleware decoration
   * @internal
   * @hidden
   * @param router The Express router this will get applied to
   * @param controller The controller class
   */
  private static processControllerMiddleware(router: IRouter, controller: Function): void {
    if (controllerMiddlewareMap.has(controller)) {
      const controllerMiddleware: RequestHandler[] = <RequestHandler[]>controllerMiddlewareMap.get(controller);
      log('Controller %s has %d middleware functions assigned', controller.name, controllerMiddleware.length);
      router.use(controllerMiddleware);
    } else {
      log('Controller %s has no middleware functions assigned', controller.name);
    }
  }

  /**
   * Process a HTTP method spec
   * @internal
   * @hidden
   * @param router The Express router this will get applied to
   * @param pathParams The URL
   * @param requestHandler The request handler
   * @param httpMethod The HTTP method used
   */
  private static processHttpMethodSpec(router: IRouter,
                                       pathParams: PathParams,
                                       requestHandler: RequestHandler,
                                       httpMethod: string): void {
    log('Method %s resolved to path %s', requestHandler.name, pathParams);
    ExpressDecoratedRouter.processRouteMiddleware(router, pathParams, routeMiddlewareMap.get(requestHandler));
    router[httpMethod](pathParams, requestHandler);
  }

  /**
   * Process a Parent decoration
   * @internal
   * @hidden
   * @param child Child controller
   * @param parent Parent controller
   * @throws {ParentControllerError} If the parent controller has not been registered
   * @throws {UnregisteredControllerError} If the child controller hasn't been registered
   */
  private static processParents(child: Function, parent: Function): void {
    log('Processing parent %s of child %s', parent.name, child.name);

    const parentRouter: IRouter | undefined = routerMap.get(parent);
    if (parentRouter) {
      log('Parent router found');
      const childRouter: IRouter | undefined = routerMap.get(child);

      if (childRouter) {
        log('Child router found');
        const childSpec: ControllerSpec = <ControllerSpec>controllerMap.get(child);
        const parentMiddleware: RequestHandler[] | undefined = controllerMiddlewareMap.get(parent);

        if (parentMiddleware && parentMiddleware.length) {
          log(
            'Parent router %s has %d middleware applied. Transferring to %s',
            parent.name,
            parentMiddleware.length,
            child.name
          );

          childRouter.use(parentMiddleware);
        }

        parentRouter.use(childSpec.root, childRouter);
      } else {
        throw new UnregisteredControllerError(child);
      }
    } else {
      throw new ParentControllerError(child, parent);
    }
  }

  /**
   * Process a @RouteMiddleware decoration
   * @internal
   * @hidden
   * @param router The Express router this will get applied to
   * @param pathParams The URL
   * @param routeMiddleware The middleware to apply
   */
  private static processRouteMiddleware(router: IRouter,
                                        pathParams: PathParams,
                                        routeMiddleware?: RequestHandler[]): void {
    if (routeMiddleware && routeMiddleware.length) {
      log('And has %d middleware functions', routeMiddleware.length);

      router.use(pathParams, routeMiddleware);
    } else {
      log('And has no middleware functions');
    }
  }

  /**
   * Process a route specification
   * @internal
   * @hidden
   * @param router The Express router this will get applied to
   * @param controller The controller class
   * @param httpMethod The HTTP method used
   * @param httpMethodSpec The HTTP method specification
   */
  private static processRouteSpec(router: IRouter,
                                  controller: Function,
                                  httpMethod: string,
                                  httpMethodSpec: HttpMethodSpec): void {

    log('Parsing %s routes for controller %s', httpMethod.toUpperCase(), controller.name);

    for (const httpMethodSpecEntry of httpMethodSpec.entries()) {
      const pathParams: PathParams = httpMethodSpecEntry[0];
      const requestHandler: RequestHandler = httpMethodSpecEntry[1];

      ExpressDecoratedRouter.processHttpMethodSpec(router, pathParams, requestHandler, httpMethod);
    }
  }
}
