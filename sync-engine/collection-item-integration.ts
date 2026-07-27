export interface CollectionItemIntegration {
  collection(request: Request): Promise<Response> | Response;
  item(request: Request, id: string): Promise<Response> | Response;
}
