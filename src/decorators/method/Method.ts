import {PathParams} from 'express-serve-static-core';
import {ExpressDecoratedRouter} from '../../ExpressDecoratedRouter';

export function Method(httpMethod: string, path: PathParams): MethodDecorator {
  return (target: any, _key: string | symbol, descriptor: PropertyDescriptor): void => {
    ExpressDecoratedRouter.addRoute(target, httpMethod, path, descriptor.value);
  };
}