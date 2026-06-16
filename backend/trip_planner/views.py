from datetime import date

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

import routing
import hos_engine
import eld_builder
from .serializers import TripInputSerializer


class PlanTripView(APIView):
    def post(self, request):
        serializer = TripInputSerializer(data=request.data)
        if not serializer.is_valid():
            first_field = next(iter(serializer.errors))
            first_error = serializer.errors[first_field][0]
            return Response(
                {"error": str(first_error), "field": first_field},
                status=status.HTTP_400_BAD_REQUEST,
            )

        data = serializer.validated_data

        try:
            current = routing.geocode(data["current_location"], "current_location")
            pickup = routing.geocode(data["pickup_location"], "pickup_location")
            dropoff = routing.geocode(data["dropoff_location"], "dropoff_location")
        except routing.RoutingError as e:
            return Response(
                {"error": e.message, "field": e.field},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            route = routing.get_directions([current, pickup, dropoff])
        except routing.RoutingError as e:
            return Response(
                {"error": e.message, "field": "dropoff_location"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        trip_input = hos_engine.TripInput(
            current_cycle_used_hrs=data["current_cycle_used"],
            segments=route["segments"],
            pickup_coords=pickup,
            dropoff_coords=dropoff,
            waypoint_coords=[current, pickup, dropoff],
        )
        simulation = hos_engine.run_simulation(trip_input)

        eld_logs = eld_builder.build_eld_logs(
            timeline=simulation["timeline"],
            trip_start_date=date.today(),
            total_miles=simulation["total_miles"],
        )

        response_data = {
            "route": {
                "total_miles": round(route["total_miles"], 1),
                "total_days": len(eld_logs),
                "polyline": route["polyline"],
                "stops": simulation["stops"],
            },
            "eld_logs": eld_logs,
        }
        if simulation.get("cycle_warning"):
            response_data["cycle_warning"] = simulation["cycle_warning"]

        return Response(response_data, status=status.HTTP_200_OK)
