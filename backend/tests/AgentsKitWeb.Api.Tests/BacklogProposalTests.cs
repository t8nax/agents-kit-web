using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public sealed class BacklogProposalTests
{
    private const string File = "# Бэклог\r\n\r\nследующий номер: B-4\r\n\r\n## B-1 Первая\r\n\r\nТекст.\r\n\r\n## B-2 Вторая\r\n\r\n## B-3 Третья\r\nХвост.\r\n";

    [Fact]
    public void Blocks_GiveEachEntryItsRangeAndTextWithoutTrailingBlankLines()
    {
        var blocks = Backlog.Blocks(File);

        Assert.Equal(["B-1", "B-2", "B-3"], blocks.Select(b => b.Number));
        Assert.Equal("## B-1 Первая\n\nТекст.", blocks[0].Text);
        Assert.Equal("## B-1 Первая\r\n\r\nТекст.\r\n\r\n", File[blocks[0].Start..blocks[0].End]);
        Assert.Equal(File.Length, blocks[2].End);
    }

    [Fact]
    public void Apply_KeepsWindowsLineEndingsAndCutsLastEntryWithoutHangingBlankLines()
    {
        var (proposal, error) = BacklogProposal.Build(["изменить B-1\n## B-1 Первая, новая\n\nДругой текст.\n", "удалить B-3"], File);
        Assert.Null(error);

        var (text, diverged) = proposal!.Apply(File);

        Assert.Null(diverged);
        Assert.Equal("# Бэклог\r\n\r\nследующий номер: B-4\r\n\r\n## B-1 Первая, новая\r\n\r\nДругой текст.\r\n\r\n## B-2 Вторая\r\n", text);
    }

    [Fact]
    public void Build_RefusesChangedNumberAndEntryNamedTwice()
    {
        Assert.Equal(
            "Изменённая запись B-1 должна начинаться строкой «## B-1 …» и быть одна",
            BacklogProposal.Build(["изменить B-1\n## B-7 Первая"], File).Error);
        Assert.Equal("Запись B-2 названа в предложении дважды", BacklogProposal.Build(["удалить B-2", "удалить B-2"], File).Error);
        Assert.Equal("Непонятная строка предложения: «переписать B-2»", BacklogProposal.Build(["переписать B-2"], File).Error);
    }

    [Fact]
    public void Split_TakesProposalBlocksOutOfAnswer()
    {
        var (text, blocks) = BacklogProposal.Split("Вот так.\r\n\r\n~~~backlog\r\nудалить B-2\r\n~~~\r\n\r\n\r\nГотово.");

        Assert.Equal("Вот так.\n\nГотово.", text);
        Assert.Equal(["удалить B-2\n"], blocks);
    }
}
