from rest_framework.pagination import PageNumberPagination


class StandardPagination(PageNumberPagination):
    """Default pagination with client-tunable page size.

    The frontend needs to fetch the full list of bots and the full list of open
    trades for a user in one call (UI shows all cards on one screen). The DRF
    default PageNumberPagination caps at PAGE_SIZE without exposing a way for
    the client to ask for more, which silently truncated >20 records on the UI.

    `max_page_size` is a hard cap so a malicious or buggy client cannot ask the
    server to materialise an unbounded queryset.
    """

    page_size = 20
    page_size_query_param = "page_size"
    max_page_size = 500
