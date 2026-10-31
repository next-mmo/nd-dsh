# 9Router Extension

`nd.9router` is an on-demand ND extension providing local AI model gateway runtime supervision, proxying, and model route aggregation for ND Router.

## Delivery Model

- **Delivery**: On-demand external package installed from **ND Extensions**.
- **Installation**: One-click install from the Discover tab in ND Extensions.
- **Runtime**: Runs on loopback only (`127.0.0.1`) under ND supervisor control.
- **Controls**: Start, stop, status monitoring, and embedded dashboard view in ND Router.

## Contributions

- **Commands**:
  - `open-9router`: View 9Router runtime status and manage local gateway routes.
  - `start-9router`: Start the 9Router managed runtime gateway.
  - `stop-9router`: Stop the 9Router managed runtime gateway.
- **Views**:
  - `overview`: 9Router local gateway runtime status and routes detail view.
- **Permissions**:
  - `ninerouter.read`: Read runtime and connection status.
  - `ninerouter.write`: Start and stop the managed runtime gateway.
