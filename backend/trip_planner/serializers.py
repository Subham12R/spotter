from rest_framework import serializers


class TripInputSerializer(serializers.Serializer):
    current_location = serializers.CharField(max_length=200, trim_whitespace=True)
    pickup_location = serializers.CharField(max_length=200, trim_whitespace=True)
    dropoff_location = serializers.CharField(max_length=200, trim_whitespace=True)
    current_cycle_used = serializers.FloatField(min_value=0.0, max_value=70.0)
